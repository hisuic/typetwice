import { GATE_PAGE, isFrameMessage } from '../shared/frame-messages';
import type { ContentEvent, GateState } from '../shared/protocol';
import { callBackground, ExtensionContextError, isExtensionContextValid } from '../shared/rpc';
import { PageGuard } from './page-guard';
import { watchPage } from './page-events';
import { checkingScreen, failureScreen, fallbackScreen, recoveryScreen } from './screens';

/**
 * checking: cover shown while the worker is asked whether the site is unlocked
 * gated:    the typing gate (an extension iframe) is on screen
 * leaving:  "Go back" was chosen and the browser is going back
 * screen:   a message screen (no earlier page, error, extension reloaded)
 * allowed:  the cover is removed until the unlock expires and a trigger fires
 */
type Mode = 'checking' | 'gated' | 'leaving' | 'screen' | 'allowed' | 'disposed';

const GATE_LOAD_TIMEOUT_MS = 8_000;
const BACK_FALLBACK_MS = 1_200;
const ORPHAN_CHECK_MS = 2_000;
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

export class GateController {
  private readonly guard = new PageGuard(() => this.shouldRepair());
  private readonly extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
  private mode: Mode = 'checking';
  private allowedUntil = 0;
  private frame: HTMLIFrameElement | null = null;
  private frameReady = false;
  /** Incremented for every state request so that late answers are ignored. */
  private sequence = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private orphanWatch: ReturnType<typeof setInterval> | undefined;
  private stopWatching: (() => void) | null = null;

  start(): void {
    for (const type of KEY_EVENTS) window.addEventListener(type, this.onPageKey, true);
    this.showChecking();
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    window.addEventListener('message', this.onWindowMessage);
    this.stopWatching = watchPage({
      onUrlChange: () => this.onUrlChange(),
      onReturn: () => this.onReturn(),
      onPageShow: (persisted) => this.onPageShow(persisted),
    });
    void this.evaluate();
  }

  /** False after dispose() or once the extension was reloaded under this page. */
  isAlive(): boolean {
    return this.mode !== 'disposed' && isExtensionContextValid();
  }

  /** Removes the cover, every listener and every page change made by this instance. */
  dispose(): void {
    if (this.mode === 'disposed') return;
    this.mode = 'disposed';
    this.sequence += 1;
    this.clearTimers();
    this.stopOrphanWatch();
    this.stopWatching?.();
    this.stopWatching = null;
    for (const type of KEY_EVENTS) window.removeEventListener(type, this.onPageKey, true);
    window.removeEventListener('message', this.onWindowMessage);
    try {
      chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    } catch {
      // The extension context may already be gone.
    }
    this.removeFrame();
    this.guard.unmount();
  }

  // ---------------------------------------------------------------------------
  // State

  /** Asks the worker about this page and moves to the matching mode. */
  private async evaluate(): Promise<void> {
    const sequence = ++this.sequence;
    let state: GateState;
    try {
      state = await callBackground('GET_GATE_STATE', {});
    } catch (error) {
      if (sequence === this.sequence && this.mode !== 'disposed') this.handleFailure(error);
      return;
    }
    if (sequence !== this.sequence || this.mode === 'disposed') return;

    if (state.status === 'inactive') {
      this.dispose();
      return;
    }
    if (state.status === 'allowed') {
      this.allowedUntil = state.allowedUntil;
      this.allow();
      return;
    }
    this.allowedUntil = 0;
    // A gate already on screen keeps its challenge. An open page is not taken
    // away by a background refresh; the next return or navigation will gate it.
    if (this.mode === 'checking') this.showGate();
  }

  private allow(): void {
    this.clearTimers();
    this.stopOrphanWatch();
    this.removeFrame();
    this.guard.unmount();
    this.mode = 'allowed';
  }

  private showChecking(): void {
    this.clearTimers();
    this.removeFrame();
    this.guard.mount();
    this.guard.setContent(checkingScreen(() => this.leave()));
    this.mode = 'checking';
    this.startOrphanWatch();
  }

  private showGate(): void {
    const frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.title = 'TypeTwice: type the sentence to continue';
    frame.src = chrome.runtime.getURL(GATE_PAGE);
    frame.addEventListener('load', () => this.focusFrame());
    this.frame = frame;
    this.frameReady = false;
    this.guard.addLayer(frame);
    this.mode = 'gated';
    this.later(GATE_LOAD_TIMEOUT_MS, () => {
      if (this.mode === 'gated' && !this.frameReady) {
        this.handleFailure(null, 'The typing screen did not load. The page stays covered until it does.');
      }
    });
  }

  private showScreen(content: HTMLElement): void {
    this.clearTimers();
    this.removeFrame();
    this.guard.mount();
    this.guard.setContent(content);
    this.mode = 'screen';
  }

  private handleFailure(
    error: unknown,
    message = 'TypeTwice could not check this page. The page stays covered until it can.',
  ): void {
    if (error instanceof ExtensionContextError || !isExtensionContextValid()) {
      this.showRecovery();
      return;
    }
    this.showScreen(
      failureScreen(
        message,
        () => {
          this.showChecking();
          void this.evaluate();
        },
        () => this.leave(),
      ),
    );
  }

  private showRecovery(): void {
    this.stopOrphanWatch();
    this.showScreen(
      recoveryScreen(
        () => location.reload(),
        () => this.leave(),
      ),
    );
  }

  /** Goes back one history entry; shows a closing screen if there is nowhere to go. */
  private leave(): void {
    if (this.mode === 'disposed') return;
    this.mode = 'leaving';
    const href = location.href;
    if (history.length > 1) {
      history.back();
      this.later(BACK_FALLBACK_MS, () => {
        if (this.mode === 'leaving' && location.href === href) this.showScreen(fallbackScreen());
      });
    } else {
      this.showScreen(fallbackScreen());
    }
  }

  /** Re-gates after the unlock has expired. Never runs on a timer alone. */
  private checkExpiry(): void {
    if (Date.now() < this.allowedUntil) return;
    if (!isExtensionContextValid()) {
      // Removed or turned off: leave the page alone.
      this.dispose();
      return;
    }
    this.showChecking();
    void this.evaluate();
  }

  // ---------------------------------------------------------------------------
  // Triggers

  private onUrlChange(): void {
    if (this.mode === 'allowed') {
      this.checkExpiry();
    } else if (this.mode === 'leaving') {
      // "Go back" landed on another page of the same site: it gets its own gate.
      this.showChecking();
      void this.evaluate();
    }
  }

  private onReturn(): void {
    if (this.mode === 'allowed') this.checkExpiry();
  }

  private onPageShow(persisted: boolean): void {
    if (!persisted) return;
    if (this.mode === 'allowed') {
      this.checkExpiry();
    } else if (this.mode === 'leaving' || this.mode === 'screen') {
      if (!isExtensionContextValid()) {
        this.showRecovery();
        return;
      }
      this.showChecking();
      void this.evaluate();
    }
  }

  private readonly onRuntimeMessage = (
    message: ContentEvent,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'PING') {
      sendResponse({ alive: this.mode !== 'disposed' });
    } else if (message?.type === 'REFRESH' && this.mode !== 'disposed') {
      void this.evaluate();
    }
    return false;
  };

  private readonly onWindowMessage = (event: MessageEvent): void => {
    // Only the gate frame we created can signal; pages cannot fake its window or origin.
    if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== this.extensionOrigin) return;
    if (!isFrameMessage(event.data)) return;
    switch (event.data.typetwice) {
      case 'ready':
        this.frameReady = true;
        this.focusFrame();
        break;
      case 'unlocked':
      case 'refresh':
        void this.evaluate();
        break;
      case 'go-back':
        this.leave();
        break;
    }
  };

  /**
   * While covered, keystrokes that land on the page (for example before the
   * gate frame has focus) must not reach the page's keyboard shortcuts.
   * Default actions are kept so browser shortcuts still work.
   */
  private readonly onPageKey = (event: KeyboardEvent): void => {
    if (this.mode === 'allowed' || this.mode === 'disposed') return;
    if (event.composedPath().includes(this.guard.host)) return;
    event.stopImmediatePropagation();
  };

  // ---------------------------------------------------------------------------
  // Helpers

  private focusFrame(): void {
    if (this.mode === 'gated' && this.frame) this.frame.focus({ preventScroll: true });
  }

  private removeFrame(): void {
    this.frame?.remove();
    this.frame = null;
    this.frameReady = false;
  }

  /** Called when the page removed the cover. An orphaned instance gives up instead. */
  private shouldRepair(): boolean {
    if (isExtensionContextValid()) return true;
    queueMicrotask(() => this.dispose());
    return false;
  }

  /** Notices when the extension is reloaded or turned off while the gate is on screen. */
  private startOrphanWatch(): void {
    if (this.orphanWatch !== undefined) return;
    this.orphanWatch = setInterval(() => {
      if (isExtensionContextValid()) return;
      if (this.mode === 'checking' || this.mode === 'gated' || this.mode === 'leaving') this.showRecovery();
      else this.stopOrphanWatch();
    }, ORPHAN_CHECK_MS);
  }

  private stopOrphanWatch(): void {
    if (this.orphanWatch === undefined) return;
    clearInterval(this.orphanWatch);
    this.orphanWatch = undefined;
  }

  private later(ms: number, task: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      task();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }
}
