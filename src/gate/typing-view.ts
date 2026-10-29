import { ForegroundTimer } from '../core/timer';
import {
  compareTyped,
  evaluateTyping,
  formatStayMessage,
  isBlockedInputType,
  measureProgress,
  remainingSeconds,
  type CharState,
  type TypingEvaluation,
  type TypingPhase,
} from '../core/typing';
import { button, h } from '../shared/dom';
import type { ChallengeView } from '../shared/protocol';

const TICK_MS = 200;

export interface TypingViewCallbacks {
  onUnlock(): void;
  onGoBack(): void;
}

/**
 * The typing screen. A native textarea holds the input; the sentence is
 * drawn from the textarea's whole value on every change, so editing,
 * selection, undo and IME all keep working the way the browser does them.
 */
export class TypingView {
  readonly element: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly words: HTMLElement;
  private readonly cells: HTMLSpanElement[] = [];
  private readonly cellStates: (CharState | null)[] = [];
  private readonly extras: HTMLSpanElement[] = [];
  private readonly endMark: HTMLSpanElement;
  private readonly progressEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly openButton: HTMLButtonElement;
  private readonly timer = new ForegroundTimer(() => performance.now());
  private readonly minDurationMs: number;
  private started = false;
  private composing = false;
  private busy = false;
  private finished = false;
  private phase: TypingPhase = 'typing';
  private tick: ReturnType<typeof setInterval> | undefined;
  private renderQueued = false;
  private marked: { caret: HTMLElement | null; selected: HTMLElement[] } = { caret: null, selected: [] };

  constructor(
    private readonly challenge: ChallengeView,
    private readonly callbacks: TypingViewCallbacks,
  ) {
    this.minDurationMs = challenge.minDurationSeconds * 1000;

    this.words = h('div', { class: 'words', 'aria-hidden': 'true' });
    for (const char of challenge.text) {
      const cell = h('span', { class: 'c pending' });
      cell.textContent = char;
      this.cells.push(cell);
      this.cellStates.push('pending');
    }
    // Zero-width space so the caret has a line box at the very end.
    this.endMark = h('span', { class: 'c end' });
    this.endMark.textContent = '​';
    this.words.append(...this.cells, this.endMark);

    this.textarea = h('textarea', {
      class: 'input',
      'aria-label': `Type this sentence: ${challenge.text}`,
      'aria-describedby': 'tt-instructions tt-live',
      spellcheck: 'false',
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      'data-gramm': 'false',
      rows: '1',
    });
    this.textarea.maxLength = challenge.text.length + 200;

    this.progressEl = h('span', { class: 'progress' });
    this.timerEl = h('span', { class: 'timer' });
    this.statusEl = h('p', { class: 'status', 'aria-hidden': 'true' });
    this.hintEl = h('p', { class: 'hint', 'aria-hidden': 'true' });
    this.errorEl = h('p', { class: 'error', role: 'alert' });
    this.liveEl = h('p', { class: 'sr-only', id: 'tt-live', role: 'status', 'aria-live': 'polite' });
    this.backButton = button('Go back', () => this.callbacks.onGoBack(), 'secondary');
    this.openButton = button(`Open anyway · ${challenge.unlockDurationMinutes} min`, () => this.requestUnlock(), 'primary');
    this.openButton.disabled = true;
    this.openButton.setAttribute('aria-describedby', 'tt-live');

    this.element = h(
      'div',
      { class: 'gate' },
      h('header', { class: 'top' }, h('span', { class: 'site' }, challenge.siteName), h('span', { 'aria-hidden': 'true' }, '·'), h('span', {}, 'Pause before you scroll.')),
      h(
        'section',
        { class: 'center' },
        h(
          'p',
          { class: 'sr-only', id: 'tt-instructions' },
          'Type the sentence exactly, including capital letters, spaces and punctuation. Pasting is turned off. ' +
            `The timer needs ${challenge.minDurationSeconds} seconds with this field focused.`,
        ),
        h('div', { class: 'stage' }, this.words, this.textarea),
        this.hintEl,
      ),
      h(
        'footer',
        { class: 'bottom' },
        h('div', { class: 'meta', 'aria-hidden': 'true' }, this.progressEl, h('span', {}, '·'), this.timerEl),
        this.statusEl,
        this.errorEl,
        this.liveEl,
        h('div', { class: 'actions' }, this.backButton, this.openButton),
      ),
    );

    this.bindEvents();
    this.update();
  }

  get typed(): string {
    return this.textarea.value;
  }

  get elapsedMs(): number {
    return this.timer.elapsedMs;
  }

  /** Starts the timer loop and focuses the input. Call after the element is in the document. */
  activate(): void {
    this.tick ??= setInterval(() => {
      this.timer.checkpoint(this.isCounting());
      this.updateStatus();
    }, TICK_MS);
    this.focusInput();
  }

  destroy(): void {
    if (this.tick !== undefined) clearInterval(this.tick);
    this.tick = undefined;
    document.removeEventListener('selectionchange', this.queueRender);
    document.removeEventListener('keydown', this.onDocumentKeyDown);
    document.removeEventListener('visibilitychange', this.onActivityChange);
    window.removeEventListener('focus', this.onWindowFocus);
    window.removeEventListener('blur', this.onActivityChange);
  }

  focusInput(): void {
    if (!this.finished) this.textarea.focus({ preventScroll: true });
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.updateStatus();
  }

  /** Unlocked; the page is about to be revealed. */
  setOpened(): void {
    this.finish('Opening…');
  }

  setLeaving(): void {
    this.finish('Going back…');
  }

  showError(message: string): void {
    this.errorEl.textContent = message;
  }

  // ---------------------------------------------------------------------------

  private finish(status: string): void {
    this.finished = true;
    this.busy = true;
    this.textarea.disabled = true;
    this.backButton.disabled = true;
    this.openButton.disabled = true;
    this.statusEl.textContent = status;
    this.liveEl.textContent = status;
    this.timer.checkpoint(false);
  }

  private bindEvents(): void {
    const input = this.textarea;
    input.addEventListener('beforeinput', (event) => {
      if (isBlockedInputType(event.inputType)) event.preventDefault();
    });
    input.addEventListener('paste', (event) => event.preventDefault());
    input.addEventListener('drop', (event) => event.preventDefault());
    input.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    });
    input.addEventListener('compositionstart', () => {
      this.composing = true;
      this.update();
    });
    input.addEventListener('compositionend', () => {
      this.composing = false;
      this.update();
    });
    input.addEventListener('input', () => {
      if (!this.started && input.value.length > 0) {
        // The minimum time starts with the first character, not when the page opens.
        this.started = true;
        this.timer.checkpoint(this.isCounting());
      }
      this.errorEl.textContent = '';
      this.update();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // Enter never adds a line break; it only confirms when everything is done.
      event.preventDefault();
      if (!event.isComposing && event.keyCode !== 229) this.requestUnlock();
    });
    for (const type of ['focus', 'blur']) input.addEventListener(type, this.onActivityChange);
    for (const type of ['select', 'selectionchange', 'keyup', 'mouseup']) input.addEventListener(type, this.queueRender);
    document.addEventListener('selectionchange', this.queueRender);
    document.addEventListener('keydown', this.onDocumentKeyDown);
    document.addEventListener('visibilitychange', this.onActivityChange);
    window.addEventListener('focus', this.onWindowFocus);
    window.addEventListener('blur', this.onActivityChange);

    // Clicking anywhere except the buttons goes back to typing.
    this.element.addEventListener('mousedown', (event) => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      event.preventDefault();
      this.focusInput();
    });
  }

  private readonly onActivityChange = (): void => {
    this.timer.checkpoint(this.isCounting());
    this.update();
  };

  private readonly onWindowFocus = (): void => {
    if (document.activeElement === document.body || document.activeElement === null) this.focusInput();
    this.onActivityChange();
  };

  /** Typing while a button has focus moves focus back to the sentence. */
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.target === this.textarea || this.finished) return;
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ' && event.target instanceof HTMLButtonElement) return;
    this.focusInput();
  };

  private readonly queueRender = (): void => {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  };

  private requestUnlock(): void {
    if (this.phase === 'ready' && !this.busy) this.callbacks.onUnlock();
  }

  /** Counts only while the gate is visible and the sentence input has focus. */
  private isCounting(): boolean {
    return (
      this.started &&
      !this.finished &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      document.activeElement === this.textarea
    );
  }

  private update(): void {
    this.render();
    this.updateStatus();
  }

  private render(): void {
    const target = this.challenge.text;
    const typed = this.textarea.value;
    const cells = compareTyped(target, typed);

    for (let i = 0; i < target.length; i += 1) {
      const state = cells[i]!.state;
      if (this.cellStates[i] !== state) {
        this.cells[i]!.className = `c ${state}`;
        this.cellStates[i] = state;
      }
    }

    const extraCount = Math.max(0, typed.length - target.length);
    while (this.extras.length > extraCount) this.extras.pop()!.remove();
    for (let j = 0; j < extraCount; j += 1) {
      let span = this.extras[j];
      if (!span) {
        span = h('span', { class: 'c extra' });
        this.words.insertBefore(span, this.endMark);
        this.extras.push(span);
      }
      const char = typed[target.length + j]!;
      if (span.textContent !== char) span.textContent = char;
    }

    this.renderCaret(target.length, typed.length);
  }

  private renderCaret(targetLength: number, typedLength: number): void {
    const at = (index: number): HTMLElement =>
      index < targetLength ? this.cells[index]! : (this.extras[index - targetLength] ?? this.endMark);

    for (const element of this.marked.selected) element.classList.remove('selected');
    this.marked.caret?.classList.remove('caret');

    const start = Math.min(this.textarea.selectionStart, typedLength);
    const end = Math.min(this.textarea.selectionEnd, typedLength);
    const selected: HTMLElement[] = [];
    for (let i = start; i < end; i += 1) {
      const element = at(i);
      element.classList.add('selected');
      selected.push(element);
    }
    const caret = at(this.textarea.selectionDirection === 'backward' ? start : end);
    caret.classList.add('caret');
    this.marked = { caret, selected };

    this.words.classList.toggle('focused', document.activeElement === this.textarea);
    this.keepVisible(caret);
  }

  private keepVisible(element: HTMLElement): void {
    const box = this.words;
    const top = element.offsetTop;
    const bottom = top + element.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }

  private updateStatus(): void {
    const typed = this.textarea.value;
    const progress = measureProgress(this.challenge.text, typed);
    const evaluation = evaluateTyping({
      target: this.challenge.text,
      typed,
      elapsedMs: this.timer.elapsedMs,
      minDurationMs: this.minDurationMs,
      composing: this.composing,
    });

    setText(
      this.progressEl,
      `${progress.typed}/${progress.total}` +
        (progress.errors > 0 ? ` · ${progress.errors} ${progress.errors === 1 ? 'error' : 'errors'}` : ''),
    );
    setText(this.timerEl, this.timerText(evaluation));
    setText(this.hintEl, this.hintText(evaluation));
    if (this.finished) return;

    if (evaluation.phase !== this.phase) this.announce(evaluation);
    this.phase = evaluation.phase;
    this.openButton.disabled = this.phase !== 'ready' || this.busy;

    let status = '';
    if (this.busy) status = 'Opening…';
    else if (this.phase === 'ready') status = 'Done. Press Enter or choose "Open anyway".';
    else if (this.phase === 'waiting') status = formatStayMessage(evaluation.remainingMs);
    else if (progress.errors > 0) status = 'Fix the highlighted characters to continue.';
    setText(this.statusEl, status);
  }

  private timerText(evaluation: TypingEvaluation): string {
    const seconds = remainingSeconds(evaluation.remainingMs);
    if (!this.started) return `Minimum ${this.challenge.minDurationSeconds}s · starts when you type`;
    if (seconds === 0) return 'Minimum time reached';
    return this.timer.isCounting ? `${seconds}s to go` : `Paused · ${seconds}s to go`;
  }

  private hintText(evaluation: TypingEvaluation): string {
    if (this.finished) return '';
    if (!this.started) return 'Start typing. The timer begins with your first keystroke. Pasting is turned off.';
    if (evaluation.remainingMs > 0 && !this.timer.isCounting) return 'Timer paused. Click the sentence to continue.';
    return '';
  }

  /** Screen reader updates only when the phase changes, not on every keystroke or second. */
  private announce(evaluation: TypingEvaluation): void {
    if (evaluation.phase === 'ready') {
      this.liveEl.textContent = 'Ready. Press Enter or the Open anyway button to continue.';
    } else if (evaluation.phase === 'waiting') {
      this.liveEl.textContent = `The sentence matches. ${formatStayMessage(evaluation.remainingMs)}`;
    } else {
      this.liveEl.textContent = 'The text no longer matches the sentence.';
    }
  }
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
