import { button, h } from '../shared/dom';
import type { FrameSignal } from '../shared/frame-messages';
import type { ChallengeView } from '../shared/protocol';
import { callBackground } from '../shared/rpc';
import { TypingView } from './typing-view';

/**
 * The gate page runs inside an extension iframe on the covered site, so
 * keystrokes never reach the site's own keyboard shortcuts and the site's
 * scripts cannot read or change the typing screen.
 */

const app = document.getElementById('app')!;
let view: TypingView | null = null;
let shownFor: string | null = null;

function signal(type: FrameSignal): void {
  // Nothing secret is sent; the content script checks the sender's window and origin.
  window.parent.postMessage({ typetwice: type }, '*');
}

function show(node: HTMLElement): void {
  view?.destroy();
  view = null;
  app.replaceChildren(node);
}

function panel(title: string, body: string, actions: HTMLButtonElement[] = [], className = ''): HTMLElement {
  return h(
    'div',
    { class: `panel ${className}`.trim() },
    title ? h('h1', { class: 'title' }, title) : null,
    h('p', { class: 'body' }, body),
    actions.length > 0 ? h('div', { class: 'actions' }, ...actions) : null,
  );
}

async function start(): Promise<void> {
  show(panel('', 'Preparing a sentence…', [button('Go back', () => void goBack())], 'loading'));
  let result;
  try {
    result = await callBackground('START_CHALLENGE', {});
  } catch {
    show(
      panel('Something went wrong', 'TypeTwice could not start a challenge. The page stays covered until it can.', [
        button('Try again', () => void start(), 'primary'),
        button('Go back', () => void goBack()),
      ]),
    );
    return;
  }

  switch (result.status) {
    case 'inactive':
      signal('refresh');
      show(panel('', 'This page is not protected by TypeTwice.'));
      return;
    case 'allowed':
      signal('unlocked');
      show(panel('', 'Opening…'));
      return;
    case 'error':
      show(
        panel('Messages could not be loaded', result.message, [
          button('Open settings', () => void callBackground('OPEN_OPTIONS', {}).catch(() => undefined), 'primary'),
          button('Try again', () => void start()),
          button('Go back', () => void goBack()),
        ]),
      );
      return;
    case 'challenge':
      showChallenge(result.challenge);
  }
}

function showChallenge(challenge: ChallengeView): void {
  const typing = new TypingView(challenge, {
    onUnlock: () => void unlock(typing, challenge),
    onGoBack: () => void goBack(challenge.id),
  });
  show(typing.element);
  view = typing;
  typing.activate();
  reportShown(challenge.id);
}

/** "Gates shown" counts a challenge once, and only when it was actually visible. */
function reportShown(challengeId: string): void {
  const send = () => {
    if (shownFor === challengeId || document.visibilityState !== 'visible') return;
    shownFor = challengeId;
    callBackground('CHALLENGE_SHOWN', { challengeId }).catch(() => {
      shownFor = null;
    });
  };
  send();
  const onVisible = () => {
    send();
    if (shownFor === challengeId) document.removeEventListener('visibilitychange', onVisible);
  };
  if (shownFor !== challengeId) document.addEventListener('visibilitychange', onVisible);
}

async function unlock(typing: TypingView, challenge: ChallengeView): Promise<void> {
  typing.setBusy(true);
  try {
    const result = await callBackground('COMPLETE_CHALLENGE', {
      challengeId: challenge.id,
      typed: typing.typed,
      elapsedMs: Math.floor(typing.elapsedMs),
    });
    if (result.ok) {
      typing.setOpened();
      signal('unlocked');
      return;
    }
    if (result.reason === 'inactive') {
      signal('refresh');
      return;
    }
    if (result.reason === 'unknown-challenge' || result.reason === 'closed') {
      show(
        panel('This challenge has ended', result.message, [
          button('Type a new sentence', () => void start(), 'primary'),
          button('Go back', () => void goBack()),
        ]),
      );
      return;
    }
    typing.showError(result.message);
  } catch {
    typing.showError('TypeTwice could not open the site. Try again.');
  }
  typing.setBusy(false);
}

async function goBack(challengeId?: string): Promise<void> {
  view?.setLeaving();
  if (challengeId) {
    const timeout = new Promise((resolve) => setTimeout(resolve, 1_000));
    await Promise.race([callBackground('DECLINE_CHALLENGE', { challengeId }).catch(() => undefined), timeout]);
  }
  signal('go-back');
}

signal('ready');
void start();
