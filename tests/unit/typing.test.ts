import { describe, expect, it } from 'vitest';
import {
  compareTyped,
  evaluateTyping,
  formatStayMessage,
  isBlockedInputType,
  measureProgress,
  remainingSeconds,
} from '../../src/core/typing';

const target = 'Hi, You.';

describe('compareTyped', () => {
  it('marks pending, correct and incorrect characters', () => {
    expect(compareTyped(target, 'Hi; y').map((c) => c.state)).toEqual([
      'correct',
      'correct',
      'incorrect',
      'correct',
      'incorrect',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('shows the expected character for mistakes and the typed one for extras', () => {
    const cells = compareTyped('ab', 'xbcd');
    expect(cells).toEqual([
      { char: 'a', state: 'incorrect' },
      { char: 'b', state: 'correct' },
      { char: 'c', state: 'extra' },
      { char: 'd', state: 'extra' },
    ]);
  });

  it('treats a wrong space as an error', () => {
    expect(compareTyped('a b', 'a  ').map((c) => c.state)).toEqual(['correct', 'correct', 'incorrect']);
  });
});

describe('measureProgress', () => {
  it('counts typed characters and errors including extras', () => {
    expect(measureProgress(target, 'Hi, you.!!')).toEqual({ typed: 8, total: 8, errors: 3 });
    expect(measureProgress(target, '')).toEqual({ typed: 0, total: 8, errors: 0 });
  });
});

describe('evaluateTyping', () => {
  const base = { target, minDurationMs: 20_000, composing: false };

  it('is not ready before the minimum time even when the text is right', () => {
    const result = evaluateTyping({ ...base, typed: target, elapsedMs: 19_999 });
    expect(result).toEqual({ phase: 'waiting', matches: true, remainingMs: 1 });
  });

  it('is not ready when a single character differs, even after the minimum time', () => {
    for (const typed of ['Hi, you.', 'Hi,  You.', 'Hi, You', 'Hi, You.x', ' Hi, You.']) {
      expect(evaluateTyping({ ...base, typed, elapsedMs: 60_000 }).phase).toBe('typing');
    }
  });

  it('is ready with an exact match and enough time', () => {
    expect(evaluateTyping({ ...base, typed: target, elapsedMs: 20_000 }).phase).toBe('ready');
  });

  it('goes back to typing when a ready buffer is edited', () => {
    expect(evaluateTyping({ ...base, typed: target, elapsedMs: 30_000 }).phase).toBe('ready');
    expect(evaluateTyping({ ...base, typed: target.slice(0, -1), elapsedMs: 30_000 }).phase).toBe('typing');
  });

  it('never completes during an IME composition', () => {
    const result = evaluateTyping({ ...base, typed: target, elapsedMs: 30_000, composing: true });
    expect(result.phase).toBe('typing');
    expect(result.matches).toBe(false);
  });
});

describe('remaining time messages', () => {
  it('rounds up to whole seconds', () => {
    expect(remainingSeconds(7_001)).toBe(8);
    expect(remainingSeconds(8_000)).toBe(8);
    expect(remainingSeconds(-5)).toBe(0);
  });

  it('formats the stay message', () => {
    expect(formatStayMessage(7_200)).toBe('Stay here for 8 more seconds.');
    expect(formatStayMessage(400)).toBe('Stay here for 1 more second.');
  });
});

describe('isBlockedInputType', () => {
  it('blocks paste, drop, replacement text and line breaks', () => {
    for (const type of ['insertFromPaste', 'insertFromDrop', 'insertReplacementText', 'insertLineBreak']) {
      expect(isBlockedInputType(type)).toBe(true);
    }
  });

  it('allows typing, deleting, IME and undo/redo', () => {
    for (const type of ['insertText', 'insertCompositionText', 'deleteContentBackward', 'historyUndo', 'historyRedo']) {
      expect(isBlockedInputType(type)).toBe(false);
    }
  });
});
