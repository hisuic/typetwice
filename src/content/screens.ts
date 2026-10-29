/** Simple overlay screens built with DOM APIs (no innerHTML, so page Trusted Types rules do not matter). */

export interface ScreenAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export function messageScreen(options: { title: string; body: string; actions: ScreenAction[]; className?: string }): HTMLElement {
  const panel = document.createElement('div');
  panel.className = `panel ${options.className ?? ''}`.trim();

  if (options.title) {
    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = options.title;
    panel.append(title);
  }

  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = options.body;
  panel.append(body);

  if (options.actions.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const action of options.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      if (action.primary) button.className = 'primary';
      button.addEventListener('click', action.onClick);
      actions.append(button);
    }
    panel.append(actions);
  }
  return panel;
}

/** Shown while the unlock state is checked; it only becomes visible if the check is slow. */
export function checkingScreen(onGoBack: () => void): HTMLElement {
  return messageScreen({
    className: 'checking',
    title: '',
    body: 'Checking…',
    actions: [{ label: 'Go back', onClick: onGoBack }],
  });
}

export function fallbackScreen(): HTMLElement {
  return messageScreen({
    title: 'You can close this tab.',
    body: 'There was no earlier page to go back to. Reload the page if you want to type a new sentence.',
    actions: [],
  });
}

export function recoveryScreen(onReload: () => void, onGoBack: () => void): HTMLElement {
  return messageScreen({
    title: 'TypeTwice was updated or turned off',
    body: 'Reload this page to continue.',
    actions: [
      { label: 'Reload page', primary: true, onClick: onReload },
      { label: 'Go back', onClick: onGoBack },
    ],
  });
}

export function failureScreen(body: string, onRetry: () => void, onGoBack: () => void): HTMLElement {
  return messageScreen({
    title: 'Something went wrong',
    body,
    actions: [
      { label: 'Try again', primary: true, onClick: onRetry },
      { label: 'Go back', onClick: onGoBack },
    ],
  });
}
