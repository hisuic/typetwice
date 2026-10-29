import { originPatterns } from '../core/sites';
import type { ContentEvent } from '../shared/protocol';
import { logWarning } from '../shared/log';
import type { BrowserHooks, InjectionReport } from './service';

export const CONTENT_SCRIPT_FILE = 'content.js';
const SCRIPT_ID_PREFIX = 'gate:';

/** BrowserHooks backed by the chrome.* extension APIs. */
export const chromeBrowser: BrowserHooks = {
  async hasOrigins(origins) {
    try {
      return await chrome.permissions.contains({ origins });
    } catch {
      return false;
    }
  },

  async removeOrigins(origins) {
    try {
      await chrome.permissions.remove({ origins });
    } catch (error) {
      logWarning('could not remove host access', error);
    }
  },

  async syncContentScripts(sites, inject) {
    const registered = (await chrome.scripting.getRegisteredContentScripts()).filter((script) =>
      script.id.startsWith(SCRIPT_ID_PREFIX),
    );
    const desired = new Map(sites.map((site) => [SCRIPT_ID_PREFIX + site.id, originPatterns(site.domains)]));

    const stale = registered
      .filter((script) => {
        const matches = desired.get(script.id);
        return !matches || !sameMembers(matches, script.matches ?? []);
      })
      .map((script) => script.id);
    if (stale.length > 0) await chrome.scripting.unregisterContentScripts({ ids: stale });

    const kept = new Set(registered.map((script) => script.id).filter((id) => !stale.includes(id)));
    const additions = [...desired]
      .filter(([id]) => !kept.has(id))
      .map(([id, matches]) => ({
        id,
        matches,
        js: [CONTENT_SCRIPT_FILE],
        runAt: 'document_start' as const,
        allFrames: false,
        persistAcrossSessions: true,
      }));
    if (additions.length > 0) await chrome.scripting.registerContentScripts(additions);

    if (!inject) return { injected: 0, failed: 0 };
    return injectIntoOpenTabs(sites.flatMap((site) => originPatterns(site.domains)));
  },

  async refreshTabs(domains) {
    const tabs = await chrome.tabs.query(domains ? { url: originPatterns(domains) } : {});
    const event: ContentEvent = { type: 'REFRESH' };
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, event, { frameId: 0 }).catch(() => undefined),
      ),
    );
  },

  async loadBundledCorpus() {
    const response = await fetch(chrome.runtime.getURL('messages.en.txt'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
};

/**
 * Tabs that were open before a site was enabled (or before the extension was
 * reloaded) have no live gate. Inject one where possible and report the rest
 * so the options page can ask for a reload instead of claiming protection.
 */
async function injectIntoOpenTabs(patterns: string[]): Promise<InjectionReport> {
  const report: InjectionReport = { injected: 0, failed: 0 };
  if (patterns.length === 0) return report;
  const tabs = await chrome.tabs.query({ url: patterns });
  await Promise.all(
    tabs.map(async (tab) => {
      // Discarded tabs reload when activated and get the registered script then.
      if (tab.id === undefined || tab.discarded) return;
      if (await isGateAlive(tab.id)) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          files: [CONTENT_SCRIPT_FILE],
          injectImmediately: true,
        });
        report.injected += 1;
      } catch (error) {
        report.failed += 1;
        logWarning('could not add the gate to an open tab', error);
      }
    }),
  );
  return report;
}

async function isGateAlive(tabId: number): Promise<boolean> {
  try {
    const event: ContentEvent = { type: 'PING' };
    const response = (await chrome.tabs.sendMessage(tabId, event, { frameId: 0 })) as { alive?: boolean } | undefined;
    return response?.alive === true;
  } catch {
    return false;
  }
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}
