import { CONTENT_REQUESTS, type Envelope, type SettingsPatch } from '../shared/protocol';
import { logWarning, safeErrorMessage } from '../shared/log';
import { chromeBrowser } from './browser';
import { GateService, type SenderInfo } from './service';
import { chromeArea } from './storage';

const service = new GateService({
  local: chromeArea(chrome.storage.local),
  session: chromeArea(chrome.storage.session),
  browser: chromeBrowser,
  now: () => Date.now(),
  random: () => Math.random(),
  newId: () => crypto.randomUUID(),
});

// Listeners are registered synchronously at the top level, as Manifest V3 requires.

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await service.initialize();
    // Gates in tabs from before an update were orphaned; replace them.
    await service.syncRegistrations(true);
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) await chrome.runtime.openOptionsPage();
  })().catch((error) => logWarning('setup failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  service.syncRegistrations(false).catch((error) => logWarning('startup sync failed', error));
});

const onPermissionsChanged = () => {
  service.handlePermissionsChanged().catch((error) => logWarning('permission sync failed', error));
};
chrome.permissions.onAdded.addListener(onPermissionsChanged);
chrome.permissions.onRemoved.addListener(onPermissionsChanged);

chrome.tabs.onRemoved.addListener((tabId) => {
  service.onTabRemoved(tabId).catch((error) => logWarning('tab cleanup failed', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleRequest(message as Record<string, unknown>, sender).then(
    (result) => sendResponse({ result } satisfies Envelope<unknown>),
    (error) => {
      logWarning('request failed', error);
      sendResponse({ error: safeErrorMessage(error) } satisfies Envelope<unknown>);
    },
  );
  return true;
});

async function handleRequest(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const type = typeof message?.type === 'string' ? message.type : '';

  if (CONTENT_REQUESTS.has(type as never)) {
    // The site is always derived from the sender, never taken from the message.
    const info: SenderInfo = { tabId: sender.tab?.id, frameId: sender.frameId, url: sender.url };
    switch (type) {
      case 'GET_GATE_STATE':
        return service.getGateState(info);
      case 'START_CHALLENGE':
        return service.startChallenge(info);
      case 'CHALLENGE_SHOWN':
        return service.markShown(info, String(message.challengeId));
      case 'COMPLETE_CHALLENGE':
        return service.completeChallenge(info, {
          challengeId: String(message.challengeId),
          typed: String(message.typed),
          elapsedMs: Number(message.elapsedMs),
        });
      case 'DECLINE_CHALLENGE':
        return service.declineChallenge(info, String(message.challengeId));
      case 'OPEN_OPTIONS':
        await chrome.runtime.openOptionsPage();
        return { ok: true };
    }
  }

  // Everything else changes settings and is only accepted from the extension's own pages.
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) {
    throw new Error('This request is only available to extension pages.');
  }
  switch (type) {
    case 'GET_SETTINGS':
      return service.getSettingsView();
    case 'UPDATE_SETTINGS':
      return service.updateSettings(readPatch(message.patch));
    case 'SET_SITE_ENABLED':
      return service.setSiteEnabled(String(message.siteId), message.enabled === true);
    case 'ADD_SITE':
      return service.addSite(String(message.input));
    case 'REMOVE_SITE':
      return service.removeSite(String(message.siteId));
    case 'IMPORT_CORPUS':
      if (typeof message.text !== 'string') throw new Error('The file content is missing.');
      return service.importCorpus(message.text, String(message.fileName ?? ''));
    case 'RESTORE_BUNDLED_CORPUS':
      return service.restoreBundledCorpus();
  }
  throw new Error('Unknown request.');
}

function readPatch(raw: unknown): SettingsPatch {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled;
  if (typeof input.minDurationSeconds === 'number') patch.minDurationSeconds = input.minDurationSeconds;
  if (typeof input.unlockDurationMinutes === 'number') patch.unlockDurationMinutes = input.unlockDurationMinutes;
  return patch;
}
