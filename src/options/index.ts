import { decodeUtf8Strict, parseCorpusBytes, type CorpusParseResult } from '../core/corpus-parser';
import { parseDomainInput } from '../core/domain-input';
import { findOverlappingSite, originPatterns } from '../core/sites';
import { button, h } from '../shared/dom';
import { SITE_STATUS_LABELS } from '../shared/labels';
import type { MutationResult, SettingsView, SiteView } from '../shared/protocol';
import { callBackground } from '../shared/rpc';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  notice: $('notice'),
  loadError: $('load-error'),
  enabled: $<HTMLInputElement>('enabled'),
  minDuration: $<HTMLInputElement>('min-duration'),
  unlockDuration: $<HTMLInputElement>('unlock-duration'),
  generalError: $('general-error'),
  sites: $('sites'),
  addForm: $<HTMLFormElement>('add-site'),
  siteInput: $<HTMLInputElement>('site-input'),
  sitePreview: $('site-preview'),
  corpusStatus: $('corpus-status'),
  fileInput: $<HTMLInputElement>('file-input'),
  restoreButton: $<HTMLButtonElement>('restore-button'),
  importPreview: $('import-preview'),
};

let view: SettingsView | null = null;
/** Sites whose permission request was just declined (they stay off). */
const declinedPermission = new Set<string>();

// ---------------------------------------------------------------------------
// Rendering

function render(next: SettingsView): void {
  view = next;
  const { settings } = next;
  els.enabled.checked = settings.enabled;
  if (document.activeElement !== els.minDuration) els.minDuration.value = String(settings.minDurationSeconds);
  if (document.activeElement !== els.unlockDuration) els.unlockDuration.value = String(settings.unlockDurationMinutes);
  els.sites.replaceChildren(...next.sites.map(renderSite));
  renderCorpusStatus(next);
  $('stat-shown').textContent = String(next.today.shown);
  $('stat-opened').textContent = String(next.today.opened);
  $('stat-declined').textContent = String(next.today.declined);
  updateSitePreview();
}

function renderSite(site: SiteView): HTMLElement {
  if (site.status !== 'off') declinedPermission.delete(site.id);
  const status = declinedPermission.has(site.id) ? 'permission-required' : site.status;
  const toggle = h('input', { type: 'checkbox', role: 'switch', 'aria-label': `Protect ${site.name}` });
  toggle.checked = site.enabled;
  toggle.addEventListener('change', guarded(() => setSiteEnabled(site, toggle.checked)));

  let note = '';
  if (status === 'permission-required') {
    note = site.enabled
      ? 'Access to this site was removed. Allow access again to protect it.'
      : 'Permission required. TypeTwice can only cover this site after you allow access.';
  } else if (site.status === 'protected' && view && !view.settings.enabled) {
    note = 'The gate is turned off in General, so this site opens without it for now.';
  }

  return h(
    'li',
    { class: 'site' },
    h('span', { class: 'site-name' }, site.name),
    h(
      'span',
      { class: 'site-controls' },
      h('span', { class: `chip chip-${status}` }, SITE_STATUS_LABELS[status]),
      site.enabled && site.status === 'permission-required'
        ? button('Allow access', guarded(() => setSiteEnabled(site, true)), 'primary')
        : null,
      toggle,
      site.builtin ? null : button('Remove', guarded(() => removeSite(site)), 'danger'),
    ),
    h('span', { class: 'site-domains' }, site.domains.map((d) => `${d} and subdomains`).join(' · ')),
    note ? h('p', { class: 'site-note' }, note) : null,
  );
}

function renderCorpusStatus(next: SettingsView): void {
  const { corpus } = next;
  if (corpus.error) {
    els.corpusStatus.textContent = corpus.error;
    els.corpusStatus.className = 'corpus-status error';
  } else if (corpus.source === 'custom') {
    const when = corpus.importedAt ? ` · imported ${new Date(corpus.importedAt).toLocaleString()}` : '';
    els.corpusStatus.textContent = `Using ${corpus.count} imported ${plural(corpus.count, 'sentence')} from ${corpus.fileName ?? 'a file'}${when}.`;
    els.corpusStatus.className = 'corpus-status';
  } else {
    els.corpusStatus.textContent = `Using the ${corpus.count} bundled ${plural(corpus.count, 'sentence')}.`;
    els.corpusStatus.className = 'corpus-status';
  }
  els.restoreButton.disabled = corpus.source === 'bundled';
}

function showNotice(message: string | undefined): void {
  els.notice.hidden = !message;
  els.notice.textContent = message ?? '';
}

function apply(result: MutationResult, errorTarget: HTMLElement = els.notice): void {
  render(result.view);
  if (result.ok) {
    showNotice(result.notice);
    if (errorTarget !== els.notice) errorTarget.hidden = true;
  } else if (errorTarget === els.notice) {
    showNotice(result.error);
  } else {
    errorTarget.textContent = result.error;
    errorTarget.hidden = false;
  }
}

async function refresh(): Promise<void> {
  try {
    render(await callBackground('GET_SETTINGS', {}));
    els.loadError.hidden = true;
  } catch {
    els.loadError.textContent = 'TypeTwice could not load its settings. Reload this page to try again.';
    els.loadError.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// General

els.enabled.addEventListener('change', guarded(async () => {
  apply(await callBackground('UPDATE_SETTINGS', { patch: { enabled: els.enabled.checked } }), els.generalError);
}));

function bindNumber(input: HTMLInputElement, key: 'minDurationSeconds' | 'unlockDurationMinutes'): void {
  input.addEventListener('change', guarded(async () => {
    const value = Number(input.value);
    apply(await callBackground('UPDATE_SETTINGS', { patch: { [key]: value } }), els.generalError);
  }));
}
bindNumber(els.minDuration, 'minDurationSeconds');
bindNumber(els.unlockDuration, 'unlockDurationMinutes');

// ---------------------------------------------------------------------------
// Sites

async function setSiteEnabled(site: SiteView, enabled: boolean): Promise<void> {
  if (enabled) {
    // Must be the first await so the request still counts as a direct response to the click.
    const granted = await requestOrigins(site.origins);
    if (!granted) {
      declinedPermission.add(site.id);
      showNotice(`${site.name} was not turned on because access was not allowed.`);
      if (view) render(view);
      return;
    }
    declinedPermission.delete(site.id);
  }
  apply(await callBackground('SET_SITE_ENABLED', { siteId: site.id, enabled }));
}

async function removeSite(site: SiteView): Promise<void> {
  apply(await callBackground('REMOVE_SITE', { siteId: site.id }));
}

async function requestOrigins(origins: string[]): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function checkSiteInput(): { domain: string; notes: string[] } | { error: string } | null {
  const input = els.siteInput.value;
  if (input.trim() === '') return null;
  const parsed = parseDomainInput(input);
  if (!parsed.ok) return { error: parsed.error };
  const overlap = view ? findOverlappingSite(parsed.domain, view.sites) : undefined;
  if (overlap) return { error: `${parsed.domain} is already covered by ${overlap.site.name} (${overlap.domain}).` };
  return { domain: parsed.domain, notes: parsed.notes };
}

function updateSitePreview(): void {
  const result = checkSiteInput();
  if (!result) {
    els.sitePreview.textContent = '';
    els.sitePreview.className = 'preview';
  } else if ('error' in result) {
    els.sitePreview.textContent = result.error;
    els.sitePreview.className = 'preview bad';
  } else {
    els.sitePreview.textContent = [`Will cover ${result.domain} and all of its subdomains (http and https).`, ...result.notes].join(' ');
    els.sitePreview.className = 'preview ok';
  }
}

els.siteInput.addEventListener('input', updateSitePreview);

els.addForm.addEventListener('submit', (event) => event.preventDefault());
els.addForm.addEventListener('submit', guarded(async () => {
  const result = checkSiteInput();
  if (!result || 'error' in result) {
    updateSitePreview();
    els.siteInput.focus();
    return;
  }
  const granted = await requestOrigins(originPatterns([result.domain]));
  const outcome = await callBackground('ADD_SITE', { input: result.domain });
  if (outcome.ok) {
    els.siteInput.value = '';
    if (!granted) declinedPermission.add(`custom:${result.domain}`);
  }
  apply(outcome);
}));

// ---------------------------------------------------------------------------
// Sentences

let pendingImport: { text: string; fileName: string } | null = null;

els.fileInput.addEventListener('change', guarded(async () => {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = '';
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseCorpusBytes(bytes);
  const decoded = parsed.ok ? decodeUtf8Strict(bytes) : null;
  pendingImport = decoded?.ok ? { text: decoded.text, fileName: file.name } : null;
  showImportPreview(file.name, parsed);
}));

function showImportPreview(fileName: string, parsed: CorpusParseResult): void {
  const container = els.importPreview;
  container.hidden = false;
  const cancel = button('Cancel', closeImportPreview);

  if (!parsed.ok) {
    container.replaceChildren(
      h('h3', {}, `${fileName} cannot be imported`),
      h('p', {}, 'Nothing was changed. Fix these lines, save the file as UTF-8 and choose it again.'),
      h('ul', { class: 'problems' }, ...parsed.errors.map((error) => h('li', {}, error.message))),
      h('div', { class: 'file-row' }, disabledButton('Replace sentences'), cancel),
    );
    return;
  }

  const { messages, stats } = parsed;
  const facts = [
    `${messages.length} ${plural(messages.length, 'sentence')} will replace the current ones.`,
    stats.duplicatesRemoved > 0 ? `${stats.duplicatesRemoved} duplicate ${plural(stats.duplicatesRemoved, 'line')} will be skipped.` : '',
    stats.convertedLines > 0
      ? `${stats.convertedLines} ${plural(stats.convertedLines, 'line')} had curly quotes, dashes, ellipses or special spaces converted.`
      : '',
  ].filter(Boolean);
  const replace = button('Replace sentences', guarded(applyImport), 'primary');

  container.replaceChildren(
    h('h3', {}, `Ready to import ${fileName}`),
    h('ul', {}, ...facts.map((fact) => h('li', {}, fact))),
    h('p', {}, messages.length > 5 ? 'First 5 sentences:' : 'Sentences:'),
    h('ul', { class: 'samples' }, ...messages.slice(0, 5).map((message) => h('li', {}, message))),
    h('div', { class: 'file-row' }, replace, cancel),
  );
}

function disabledButton(label: string): HTMLButtonElement {
  const element = button(label, () => undefined, 'primary');
  element.disabled = true;
  return element;
}

function closeImportPreview(): void {
  pendingImport = null;
  els.importPreview.hidden = true;
  els.importPreview.replaceChildren();
}

async function applyImport(): Promise<void> {
  if (!pendingImport) return;
  const result = await callBackground('IMPORT_CORPUS', pendingImport);
  if (result.ok) closeImportPreview();
  apply(result);
}

els.restoreButton.addEventListener('click', guarded(async () => {
  closeImportPreview();
  apply(await callBackground('RESTORE_BUNDLED_CORPUS', {}));
}));

// ---------------------------------------------------------------------------

/** Runs an async handler and reports failures instead of leaving the page silently stale. */
function guarded(task: () => Promise<void>): () => void {
  return () => {
    task().catch(() => {
      showNotice('TypeTwice could not save that change. Try again.');
      void refresh();
    });
  };
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// Keep the page current when stats change or access is changed in the browser's own settings.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void refresh();
});
chrome.permissions.onAdded.addListener(() => void refresh());
chrome.permissions.onRemoved.addListener(() => void refresh());

void refresh();
