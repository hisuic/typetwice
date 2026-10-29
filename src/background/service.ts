import { parseCorpusBytes, parseCorpusText } from '../core/corpus-parser';
import { isAllowed, pruneGrants, resolveGrant } from '../core/grants';
import { corpusVersion } from '../core/hash';
import { parseDomainInput } from '../core/domain-input';
import { pickMessage } from '../core/picker';
import { MIN_DURATION_RANGE, UNLOCK_DURATION_RANGE, isIntegerInRange, sanitizeSettings } from '../core/settings';
import { findOverlappingSite, findSiteForUrl, makeCustomSite, originPatterns } from '../core/sites';
import { localDateKey, recordStat, statsForDay } from '../core/stats';
import type { Challenge, Corpus, GrantMap, Settings, SiteRule, StatKind, StatsMap } from '../core/types';
import type {
  CompleteChallengeResult,
  CorpusView,
  GateState,
  MutationResult,
  SettingsPatch,
  SettingsView,
  SiteView,
  StartChallengeResult,
} from '../shared/protocol';
import { SerialQueue } from './queue';
import { LOCAL_KEYS, SESSION_KEYS, type KeyValueArea } from './storage';

export interface InjectionReport {
  injected: number;
  failed: number;
}

/** Browser-specific side effects, injected so the logic can run in tests. */
export interface BrowserHooks {
  hasOrigins(origins: string[]): Promise<boolean>;
  removeOrigins(origins: string[]): Promise<void>;
  /** Registers content scripts for exactly these sites; optionally injects into tabs already open. */
  syncContentScripts(sites: readonly SiteRule[], inject: boolean): Promise<InjectionReport>;
  /** Asks content scripts to re-check their state; without domains every tab is asked. */
  refreshTabs(domains?: readonly string[]): Promise<void>;
  loadBundledCorpus(): Promise<Uint8Array>;
}

export interface SenderInfo {
  tabId?: number;
  frameId?: number;
  url?: string;
}

export interface ServiceDeps {
  local: KeyValueArea;
  session: KeyValueArea;
  browser: BrowserHooks;
  now: () => number;
  random: () => number;
  newId: () => string;
}

type ChallengeMap = Record<string, Challenge>;
type CorpusResult = { ok: true; corpus: Corpus } | { ok: false; error: string };

interface SettingsChange {
  settings: Settings;
  /** Extra chrome.storage.local values written together with the settings. */
  local?: Record<string, unknown>;
  removeLocal?: string[];
  removeOrigins?: string[];
  /** Re-register content scripts and refresh open tabs. */
  resync: boolean;
  notice?: string;
}

const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHALLENGES_PER_TAB = 5;
/** Allowed difference between reported foreground time and wall-clock time. */
const ELAPSED_SLACK_MS = 2_000;

export class GateService {
  private readonly queue = new SerialQueue();
  private bundled: Promise<CorpusResult> | null = null;

  constructor(private readonly deps: ServiceDeps) {}

  /** Writes default settings on first install. */
  initialize(): Promise<void> {
    return this.queue.run(async () => {
      const stored = await this.deps.local.get(LOCAL_KEYS.settings);
      await this.deps.local.set({ [LOCAL_KEYS.settings]: sanitizeSettings(stored) });
    });
  }

  // ---------------------------------------------------------------------------
  // Content script requests

  async getGateState(sender: SenderInfo): Promise<GateState> {
    const settings = await this.loadSettings();
    const site = await this.activeSiteFor(sender, settings);
    if (!site) return { status: 'inactive' };
    const allowedUntil = (await this.loadGrants())[site.id];
    if (allowedUntil !== undefined && isAllowed(allowedUntil, this.deps.now())) {
      return { status: 'allowed', siteId: site.id, siteName: site.name, allowedUntil };
    }
    return { status: 'gated', siteId: site.id, siteName: site.name };
  }

  startChallenge(sender: SenderInfo): Promise<StartChallengeResult> {
    return this.queue.run(async () => {
      const settings = await this.loadSettings();
      const site = await this.activeSiteFor(sender, settings);
      if (!site || sender.tabId === undefined) return { status: 'inactive' };

      const now = this.deps.now();
      const allowedUntil = (await this.loadGrants())[site.id];
      if (allowedUntil !== undefined && isAllowed(allowedUntil, now)) return { status: 'allowed', allowedUntil };

      const loaded = await this.activeCorpus(settings);
      if (!loaded.ok) return { status: 'error', message: loaded.error };

      const lastPicked = (await this.deps.session.get<Record<string, string>>(SESSION_KEYS.lastPicked)) ?? {};
      const text = pickMessage(loaded.corpus.messages, lastPicked[site.id], this.deps.random);
      const challenge: Challenge = {
        id: this.deps.newId(),
        tabId: sender.tabId,
        siteId: site.id,
        text,
        corpusVersion: loaded.corpus.version,
        minDurationSeconds: settings.minDurationSeconds,
        unlockDurationMinutes: settings.unlockDurationMinutes,
        createdAt: now,
        status: 'pending',
        shownCounted: false,
      };
      const challenges = pruneChallenges({ ...(await this.loadChallenges()), [challenge.id]: challenge }, now);
      await this.deps.session.set({
        [SESSION_KEYS.challenges]: challenges,
        [SESSION_KEYS.lastPicked]: { ...lastPicked, [site.id]: text },
      });

      return {
        status: 'challenge',
        challenge: {
          id: challenge.id,
          siteName: site.name,
          text,
          corpusVersion: challenge.corpusVersion,
          minDurationSeconds: challenge.minDurationSeconds,
          unlockDurationMinutes: challenge.unlockDurationMinutes,
        },
      };
    });
  }

  /** Counts "Gates shown" once per challenge, when the gate was actually visible. */
  markShown(sender: SenderInfo, challengeId: string): Promise<{ ok: boolean }> {
    return this.queue.run(async () => {
      const challenges = await this.loadChallenges();
      const challenge = challenges[challengeId];
      if (!challenge || challenge.tabId !== sender.tabId || challenge.shownCounted) return { ok: false };
      challenges[challengeId] = { ...challenge, shownCounted: true };
      await this.deps.session.set({ [SESSION_KEYS.challenges]: challenges });
      await this.recordStat('shown');
      return { ok: true };
    });
  }

  async completeChallenge(
    sender: SenderInfo,
    input: { challengeId: string; typed: string; elapsedMs: number },
  ): Promise<CompleteChallengeResult> {
    const outcome = await this.queue.run(async (): Promise<{ result: CompleteChallengeResult; site?: SiteRule }> => {
      const challenges = await this.loadChallenges();
      const challenge = challenges[input.challengeId];
      if (!challenge || challenge.tabId !== sender.tabId) {
        return { result: failure('unknown-challenge', 'This challenge has expired. Start a new one.') };
      }
      const settings = await this.loadSettings();
      const site = await this.activeSiteFor(sender, settings);
      if (!site || site.id !== challenge.siteId) {
        return { result: failure('inactive', 'This site is no longer protected.') };
      }

      const now = this.deps.now();
      const grants = await this.loadGrants();
      if (challenge.status === 'completed') {
        // A repeated request for the same challenge: report the grant it produced, never a new one.
        const existing = grants[site.id];
        return existing !== undefined && isAllowed(existing, now)
          ? { result: { ok: true, allowedUntil: existing } }
          : { result: failure('closed', 'This challenge was already used. Start a new one.') };
      }
      if (challenge.status === 'declined') {
        return { result: failure('closed', 'You chose to go back on this challenge.') };
      }
      if (input.typed !== challenge.text) {
        return { result: failure('mismatch', 'The text does not match the sentence yet.') };
      }
      const minMs = challenge.minDurationSeconds * 1000;
      const maxPlausibleMs = now - challenge.createdAt + ELAPSED_SLACK_MS;
      if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < minMs || input.elapsedMs > maxPlausibleMs) {
        return { result: failure('too-early', 'The minimum time has not passed yet.') };
      }

      const grant = resolveGrant(grants[site.id], now, challenge.unlockDurationMinutes);
      challenges[challenge.id] = { ...challenge, status: 'completed' };
      await this.deps.session.set({
        [SESSION_KEYS.challenges]: challenges,
        [SESSION_KEYS.grants]: pruneGrants({ ...grants, [site.id]: grant.allowedUntil }, now),
      });
      // Another tab may have unlocked a moment earlier; only a new grant counts as "opened".
      if (grant.created) await this.recordStat('opened');
      return { result: { ok: true, allowedUntil: grant.allowedUntil }, site: grant.created ? site : undefined };
    });

    if (outcome.site) await this.deps.browser.refreshTabs(outcome.site.domains);
    return outcome.result;
  }

  declineChallenge(sender: SenderInfo, challengeId: string): Promise<{ ok: boolean }> {
    return this.queue.run(async () => {
      const challenges = await this.loadChallenges();
      const challenge = challenges[challengeId];
      if (!challenge || challenge.tabId !== sender.tabId) return { ok: false };
      if (challenge.status !== 'pending') return { ok: true };
      challenges[challengeId] = { ...challenge, status: 'declined' };
      await this.deps.session.set({ [SESSION_KEYS.challenges]: challenges });
      await this.recordStat('declined');
      return { ok: true };
    });
  }

  onTabRemoved(tabId: number): Promise<void> {
    return this.queue.run(async () => {
      const challenges = await this.loadChallenges();
      const kept = Object.fromEntries(Object.entries(challenges).filter(([, c]) => c.tabId !== tabId));
      if (Object.keys(kept).length !== Object.keys(challenges).length) {
        await this.deps.session.set({ [SESSION_KEYS.challenges]: kept });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Extension page requests

  async getSettingsView(): Promise<SettingsView> {
    const settings = await this.loadSettings();
    const sites = await Promise.all(
      settings.sites.map(async (site): Promise<SiteView> => {
        const origins = originPatterns(site.domains);
        const granted = await this.deps.browser.hasOrigins(origins);
        return { ...site, origins, status: site.enabled ? (granted ? 'protected' : 'permission-required') : 'off' };
      }),
    );
    const loaded = await this.activeCorpus(settings);
    const corpus: CorpusView = loaded.ok
      ? {
          source: loaded.corpus.source,
          count: loaded.corpus.messages.length,
          version: loaded.corpus.version,
          importedAt: loaded.corpus.importedAt,
          fileName: loaded.corpus.fileName,
        }
      : { source: settings.corpusSource, count: 0, version: '', error: loaded.error };
    const stats = (await this.deps.local.get<StatsMap>(LOCAL_KEYS.stats)) ?? {};
    const today = statsForDay(stats, localDateKey(new Date(this.deps.now())));
    return { settings, sites, corpus, today };
  }

  updateSettings(patch: SettingsPatch): Promise<MutationResult> {
    return this.mutate(async (settings) => {
      const next = { ...settings };
      if (patch.minDurationSeconds !== undefined) {
        if (!isIntegerInRange(patch.minDurationSeconds, MIN_DURATION_RANGE)) {
          return { error: 'Minimum typing time must be a whole number from 5 to 300 seconds.' };
        }
        next.minDurationSeconds = patch.minDurationSeconds;
      }
      if (patch.unlockDurationMinutes !== undefined) {
        if (!isIntegerInRange(patch.unlockDurationMinutes, UNLOCK_DURATION_RANGE)) {
          return { error: 'Unlock time must be a whole number from 1 to 60 minutes.' };
        }
        next.unlockDurationMinutes = patch.unlockDurationMinutes;
      }
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      return { settings: next, resync: patch.enabled !== undefined && patch.enabled !== settings.enabled };
    });
  }

  setSiteEnabled(siteId: string, enabled: boolean): Promise<MutationResult> {
    return this.mutate(async (settings) => {
      const site = settings.sites.find((s) => s.id === siteId);
      if (!site) return { error: 'That site is no longer in the list.' };
      const origins = originPatterns(site.domains);
      if (enabled && !(await this.deps.browser.hasOrigins(origins))) {
        return { error: `Permission required: allow access to ${site.domains.join(', ')} to protect ${site.name}.` };
      }
      const sites = settings.sites.map((s) => (s.id === siteId ? { ...s, enabled } : s));
      return {
        settings: { ...settings, sites },
        removeOrigins: enabled ? [] : unusedOrigins(origins, sites, siteId),
        resync: true,
        notice: enabled ? `${site.name} is protected.` : `${site.name} is turned off.`,
      };
    });
  }

  addSite(input: string): Promise<MutationResult> {
    return this.mutate(async (settings) => {
      const parsed = parseDomainInput(input);
      if (!parsed.ok) return { error: parsed.error };
      const overlap = findOverlappingSite(parsed.domain, settings.sites);
      if (overlap) return { error: overlapMessage(parsed.domain, overlap) };
      const granted = await this.deps.browser.hasOrigins(originPatterns([parsed.domain]));
      return {
        settings: { ...settings, sites: [...settings.sites, makeCustomSite(parsed.domain, granted)] },
        resync: true,
        notice: granted
          ? `Added ${parsed.domain}. It is protected.`
          : `Added ${parsed.domain}, but it is not protected until you allow access.`,
      };
    });
  }

  removeSite(siteId: string): Promise<MutationResult> {
    return this.mutate(async (settings) => {
      const site = settings.sites.find((s) => s.id === siteId);
      if (!site) return { error: 'That site is no longer in the list.' };
      if (site.builtin) return { error: `${site.name} is built in. Turn it off instead.` };
      const sites = settings.sites.filter((s) => s.id !== siteId);
      return {
        settings: { ...settings, sites },
        removeOrigins: unusedOrigins(originPatterns(site.domains), sites, siteId),
        resync: true,
        notice: `Removed ${site.name}.`,
      };
    });
  }

  importCorpus(text: string, fileName: string): Promise<MutationResult> {
    return this.mutate(async (settings) => {
      const parsed = parseCorpusText(text);
      if (!parsed.ok) {
        const [first] = parsed.errors;
        const more = parsed.errors.length > 1 ? ` (${parsed.errors.length - 1} more problems)` : '';
        return { error: `Nothing was imported. ${first?.message ?? ''}${more}` };
      }
      const corpus: Corpus = {
        version: corpusVersion('custom', parsed.messages),
        source: 'custom',
        messages: parsed.messages,
        importedAt: this.deps.now(),
        fileName: fileName.split(/[\\/]/).pop()?.slice(0, 120) || 'messages.txt',
      };
      return {
        settings: { ...settings, corpusSource: 'custom' },
        local: { [LOCAL_KEYS.customCorpus]: corpus },
        resync: false,
        notice:
          `Imported ${parsed.messages.length} ${parsed.messages.length === 1 ? 'sentence' : 'sentences'}. ` +
          'New challenges use them; a challenge already on screen keeps its sentence.',
      };
    });
  }

  restoreBundledCorpus(): Promise<MutationResult> {
    return this.mutate(async (settings) => ({
      settings: { ...settings, corpusSource: 'bundled' },
      removeLocal: [LOCAL_KEYS.customCorpus],
      resync: false,
      notice: 'Restored the bundled messages.',
    }));
  }

  // ---------------------------------------------------------------------------
  // Registration and permissions

  /** Re-registers content scripts and drops grants of sites that are no longer protected. */
  async syncRegistrations(inject: boolean): Promise<InjectionReport> {
    return this.queue.run(() => this.syncLocked(inject));
  }

  async handlePermissionsChanged(): Promise<void> {
    await this.syncRegistrations(true);
    await this.deps.browser.refreshTabs();
  }

  // ---------------------------------------------------------------------------
  // Internals

  private async mutate(change: (settings: Settings) => Promise<SettingsChange | { error: string }>): Promise<MutationResult> {
    const outcome = await this.queue.run(async () => {
      const result = await change(await this.loadSettings());
      if ('error' in result) return result;
      await this.deps.local.set({ [LOCAL_KEYS.settings]: result.settings, ...result.local });
      if (result.removeLocal?.length) await this.deps.local.remove(result.removeLocal);
      if (result.removeOrigins?.length) await this.deps.browser.removeOrigins(result.removeOrigins);
      const report = result.resync ? await this.syncLocked(true) : { injected: 0, failed: 0 };
      return { ...result, report };
    });
    if ('error' in outcome) return { ok: false, error: outcome.error, view: await this.getSettingsView() };
    if (outcome.resync) await this.deps.browser.refreshTabs();
    const notices = [outcome.notice];
    if (outcome.report.failed > 0) {
      notices.push(`${outcome.report.failed} open tab(s) could not be protected yet. Reload them to show the gate.`);
    }
    const notice = notices.filter(Boolean).join(' ') || undefined;
    return { ok: true, view: await this.getSettingsView(), notice };
  }

  private async syncLocked(inject: boolean): Promise<InjectionReport> {
    const settings = await this.loadSettings();
    const active: SiteRule[] = [];
    if (settings.enabled) {
      for (const site of settings.sites) {
        if (site.enabled && (await this.deps.browser.hasOrigins(originPatterns(site.domains)))) active.push(site);
      }
    }
    // Turning a site (or the whole extension) back on must start with a new challenge.
    const grants = await this.loadGrants();
    const activeIds = new Set(active.map((site) => site.id));
    const kept = pruneGrants(
      Object.fromEntries(Object.entries(grants).filter(([siteId]) => activeIds.has(siteId))),
      this.deps.now(),
    );
    if (Object.keys(kept).length !== Object.keys(grants).length) {
      await this.deps.session.set({ [SESSION_KEYS.grants]: kept });
    }
    return this.deps.browser.syncContentScripts(active, inject);
  }

  private async activeSiteFor(sender: SenderInfo, settings: Settings): Promise<SiteRule | null> {
    if (sender.tabId === undefined || sender.frameId !== 0 || !settings.enabled) return null;
    const site = findSiteForUrl(sender.url, settings.sites);
    if (!site || !site.enabled) return null;
    return (await this.deps.browser.hasOrigins(originPatterns(site.domains))) ? site : null;
  }

  private async activeCorpus(settings: Settings): Promise<CorpusResult> {
    if (settings.corpusSource === 'custom') {
      const stored = await this.deps.local.get<Corpus>(LOCAL_KEYS.customCorpus);
      if (isUsableCorpus(stored)) return { ok: true, corpus: stored };
      return {
        ok: false,
        error: 'The imported messages could not be loaded. Import the file again or restore the bundled messages.',
      };
    }
    return this.bundledCorpus();
  }

  private bundledCorpus(): Promise<CorpusResult> {
    if (!this.bundled) {
      this.bundled = (async (): Promise<CorpusResult> => {
        try {
          const parsed = parseCorpusBytes(await this.deps.browser.loadBundledCorpus());
          if (!parsed.ok) {
            return { ok: false, error: `The bundled message file is invalid. ${parsed.errors[0]?.message ?? ''}` };
          }
          const corpus: Corpus = {
            version: corpusVersion('bundled', parsed.messages),
            source: 'bundled',
            messages: parsed.messages,
          };
          return { ok: true, corpus };
        } catch {
          this.bundled = null;
          return { ok: false, error: 'The bundled message file could not be read.' };
        }
      })();
    }
    return this.bundled;
  }

  private async loadSettings(): Promise<Settings> {
    return sanitizeSettings(await this.deps.local.get(LOCAL_KEYS.settings));
  }

  private async loadGrants(): Promise<GrantMap> {
    return (await this.deps.session.get<GrantMap>(SESSION_KEYS.grants)) ?? {};
  }

  private async loadChallenges(): Promise<ChallengeMap> {
    return (await this.deps.session.get<ChallengeMap>(SESSION_KEYS.challenges)) ?? {};
  }

  private async recordStat(kind: StatKind): Promise<void> {
    const stats = (await this.deps.local.get<StatsMap>(LOCAL_KEYS.stats)) ?? {};
    await this.deps.local.set({ [LOCAL_KEYS.stats]: recordStat(stats, kind, new Date(this.deps.now())) });
  }
}

function failure(
  reason: Extract<CompleteChallengeResult, { ok: false }>['reason'],
  message: string,
): CompleteChallengeResult {
  return { ok: false, reason, message };
}

/** Drops stale challenges and keeps only the newest few per tab. */
function pruneChallenges(challenges: ChallengeMap, now: number): ChallengeMap {
  const fresh = Object.values(challenges)
    .filter((c) => now - c.createdAt < CHALLENGE_TTL_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
  const perTab = new Map<number, number>();
  const result: ChallengeMap = {};
  for (const challenge of fresh) {
    const count = perTab.get(challenge.tabId) ?? 0;
    if (count >= MAX_CHALLENGES_PER_TAB) continue;
    perTab.set(challenge.tabId, count + 1);
    result[challenge.id] = challenge;
  }
  return result;
}

/** Host patterns of a removed or disabled site that no other enabled site still needs. */
function unusedOrigins(origins: string[], sites: readonly SiteRule[], siteId: string): string[] {
  const needed = new Set(
    sites.filter((s) => s.id !== siteId && s.enabled).flatMap((s) => originPatterns(s.domains)),
  );
  return origins.filter((origin) => !needed.has(origin));
}

function overlapMessage(domain: string, overlap: { site: SiteRule; domain: string }): string {
  const owner = overlap.site.name === overlap.domain ? overlap.domain : `${overlap.site.name} (${overlap.domain})`;
  if (domain === overlap.domain || domain.endsWith(`.${overlap.domain}`)) {
    return `${domain} is already covered by ${owner}.`;
  }
  return `${domain} would overlap with ${owner}, which is already in the list. Remove it first.`;
}

function isUsableCorpus(value: unknown): value is Corpus {
  if (!value || typeof value !== 'object') return false;
  const corpus = value as Partial<Corpus>;
  return (
    typeof corpus.version === 'string' &&
    Array.isArray(corpus.messages) &&
    corpus.messages.length > 0 &&
    corpus.messages.every((m) => typeof m === 'string' && m.length > 0)
  );
}
