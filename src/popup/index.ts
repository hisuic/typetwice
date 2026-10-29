import { h } from '../shared/dom';
import { SITE_STATUS_LABELS } from '../shared/labels';
import type { SettingsView } from '../shared/protocol';
import { callBackground } from '../shared/rpc';

const enabledInput = document.getElementById('enabled') as HTMLInputElement;
const pausedNote = document.getElementById('paused')!;
const sitesList = document.getElementById('sites')!;
const errorEl = document.getElementById('error')!;

function render(view: SettingsView): void {
  enabledInput.checked = view.settings.enabled;
  pausedNote.hidden = view.settings.enabled;
  document.getElementById('stat-shown')!.textContent = String(view.today.shown);
  document.getElementById('stat-opened')!.textContent = String(view.today.opened);
  document.getElementById('stat-declined')!.textContent = String(view.today.declined);
  sitesList.replaceChildren(
    ...view.sites.map((site) =>
      h(
        'li',
        {},
        h('span', { class: 'name', title: site.domains.join(', ') }, site.name),
        h('span', { class: `status-${site.status}` }, SITE_STATUS_LABELS[site.status]),
      ),
    ),
  );
}

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

async function load(): Promise<void> {
  try {
    render(await callBackground('GET_SETTINGS', {}));
  } catch {
    showError('TypeTwice could not load its settings.');
  }
}

enabledInput.addEventListener('change', async () => {
  try {
    const result = await callBackground('UPDATE_SETTINGS', { patch: { enabled: enabledInput.checked } });
    render(result.view);
    if (!result.ok) showError(result.error);
  } catch {
    showError('The change could not be saved.');
    void load();
  }
});

document.getElementById('open-settings')!.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

void load();
