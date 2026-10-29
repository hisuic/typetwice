/**
 * Pure helpers for comparing typed text with the challenge sentence and for
 * deciding which phase the gate is in.
 */

export type CharState = 'pending' | 'correct' | 'incorrect' | 'extra';

export interface CharCell {
  /** The character to draw: the expected one, or the typed one for extras. */
  char: string;
  state: CharState;
}

export interface TypingProgress {
  /** Characters in the input buffer that fall within the sentence. */
  typed: number;
  total: number;
  /** Positions that differ from the sentence, including extra characters. */
  errors: number;
}

/** Phases that depend on the input; CHECKING/ALLOWED/DECLINED live in the gate. */
export type TypingPhase = 'typing' | 'waiting' | 'ready';

export interface TypingEvaluation {
  phase: TypingPhase;
  matches: boolean;
  remainingMs: number;
}

/**
 * Builds one cell per sentence character plus one per extra typed character.
 * The comparison is strict: case, spaces and punctuation must all match.
 */
export function compareTyped(target: string, typed: string): CharCell[] {
  const cells: CharCell[] = [];
  for (let i = 0; i < target.length; i += 1) {
    const expected = target[i]!;
    if (i >= typed.length) {
      cells.push({ char: expected, state: 'pending' });
    } else {
      cells.push({ char: expected, state: typed[i] === expected ? 'correct' : 'incorrect' });
    }
  }
  for (let i = target.length; i < typed.length; i += 1) {
    cells.push({ char: typed[i]!, state: 'extra' });
  }
  return cells;
}

export function measureProgress(target: string, typed: string): TypingProgress {
  let errors = Math.max(0, typed.length - target.length);
  const overlap = Math.min(target.length, typed.length);
  for (let i = 0; i < overlap; i += 1) {
    if (typed[i] !== target[i]) errors += 1;
  }
  return { typed: overlap, total: target.length, errors };
}

/**
 * Unlocking needs the whole buffer to equal the sentence and enough
 * foreground time. While an IME composition is active nothing is final yet.
 */
export function evaluateTyping(input: {
  target: string;
  typed: string;
  elapsedMs: number;
  minDurationMs: number;
  composing: boolean;
}): TypingEvaluation {
  const remainingMs = Math.max(0, input.minDurationMs - input.elapsedMs);
  const matches = !input.composing && input.typed === input.target;
  if (!matches) return { phase: 'typing', matches, remainingMs };
  return { phase: remainingMs > 0 ? 'waiting' : 'ready', matches, remainingMs };
}

/** Whole seconds left, rounded up so "0 seconds" is never shown too early. */
export function remainingSeconds(remainingMs: number): number {
  return Math.ceil(Math.max(0, remainingMs) / 1000);
}

export function formatStayMessage(remainingMs: number): string {
  const seconds = remainingSeconds(remainingMs);
  return `Stay here for ${seconds} more ${seconds === 1 ? 'second' : 'seconds'}.`;
}

/**
 * beforeinput types that must not reach the challenge input: anything that
 * inserts text the user did not type key by key, and line breaks.
 */
const BLOCKED_INPUT_TYPES = new Set([
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'insertLink',
  'insertLineBreak',
  'insertParagraph',
  'deleteByDrag',
]);

export function isBlockedInputType(inputType: string): boolean {
  return BLOCKED_INPUT_TYPES.has(inputType);
}
