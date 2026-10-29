import { beforeEach, describe, expect, it } from 'vitest';
import { GateService, type BrowserHooks, type SenderInfo } from '../../src/background/service';
import { LOCAL_KEYS, MemoryArea } from '../../src/background/storage';
import { originPatterns } from '../../src/core/sites';
import type { SiteRule, StatsMap } from '../../src/core/types';
import type { ChallengeView } from '../../src/shared/protocol';

class FakeBrowser implements BrowserHooks {
  granted = new Set<string>();
  registered: string[] = [];
  refreshed: (readonly string[] | undefined)[] = [];
  bundled = 'First sentence.\nSecond sentence.\nThird sentence.\n';

  grant(...domains: string[]) {
    for (const origin of originPatterns(domains)) this.granted.add(origin);
  }
  async hasOrigins(origins: string[]) {
    return origins.every((o) => this.granted.has(o));
  }
  async removeOrigins(origins: string[]) {
    for (const o of origins) this.granted.delete(o);
  }
  async syncContentScripts(sites: readonly SiteRule[]) {
    this.registered = sites.map((s) => s.id);
    return { injected: 0, failed: 0 };
  }
  async refreshTabs(domains?: readonly string[]) {
    this.refreshed.push(domains);
  }
  async loadBundledCorpus() {
    return new TextEncoder().encode(this.bundled);
  }
}

const tab = (tabId: number, url: string, frameId = 0): SenderInfo => ({ tabId, frameId, url });

let now: number;
let local: MemoryArea;
let session: MemoryArea;
let browser: FakeBrowser;
let ids: number;

function makeService() {
  return new GateService({
    local,
    session,
    browser,
    now: () => now,
    random: () => 0,
    newId: () => `challenge-${++ids}`,
  });
}

async function startChallenge(service: GateService, sender: SenderInfo): Promise<ChallengeView> {
  const result = await service.startChallenge(sender);
  if (result.status !== 'challenge') throw new Error(`Expected a challenge, got ${result.status}`);
  return result.challenge;
}

async function todayStats(): Promise<StatsMap[string] | undefined> {
  const stats = await local.get<StatsMap>(LOCAL_KEYS.stats);
  return Object.values(stats ?? {})[0];
}

async function enableBuiltins(service: GateService) {
  browser.grant('x.com', 'twitter.com', 'instagram.com');
  expect((await service.setSiteEnabled('x', true)).ok).toBe(true);
  expect((await service.setSiteEnabled('instagram', true)).ok).toBe(true);
}

beforeEach(() => {
  now = new Date(2026, 9, 29, 12, 0, 0).getTime();
  local = new MemoryArea();
  session = new MemoryArea();
  browser = new FakeBrowser();
  ids = 0;
});

describe('gate state', () => {
  it('is inactive until a site is enabled with host access', async () => {
    const service = makeService();
    await service.initialize();
    expect(await service.getGateState(tab(1, 'https://x.com/home'))).toEqual({ status: 'inactive' });

    // Enabling without permission is refused.
    const refused = await service.setSiteEnabled('x', true);
    expect(refused.ok).toBe(false);
    expect(refused.view.sites[0]?.status).toBe('off');

    browser.grant('x.com', 'twitter.com');
    const enabled = await service.setSiteEnabled('x', true);
    expect(enabled.ok).toBe(true);
    expect(enabled.view.sites[0]?.status).toBe('protected');
    expect(browser.registered).toEqual(['x']);
    expect(await service.getGateState(tab(1, 'https://x.com/home'))).toEqual({
      status: 'gated',
      siteId: 'x',
      siteName: 'X',
    });
  });

  it('ignores subframes, other hosts and look-alikes', async () => {
    const service = makeService();
    await enableBuiltins(service);
    expect((await service.getGateState(tab(1, 'https://x.com/', 3))).status).toBe('inactive');
    expect((await service.getGateState(tab(1, 'https://notx.com/'))).status).toBe('inactive');
    expect((await service.getGateState(tab(1, 'https://x.com.evil.example/'))).status).toBe('inactive');
    expect((await service.getGateState({ url: 'https://x.com/' })).status).toBe('inactive');
  });

  it('reports permission-required when access was revoked', async () => {
    const service = makeService();
    await enableBuiltins(service);
    await browser.removeOrigins(originPatterns(['instagram.com']));
    await service.handlePermissionsChanged();
    const view = await service.getSettingsView();
    expect(view.sites.find((s) => s.id === 'instagram')?.status).toBe('permission-required');
    expect(browser.registered).toEqual(['x']);
    expect((await service.getGateState(tab(1, 'https://instagram.com/'))).status).toBe('inactive');
  });
});

describe('challenges and grants', () => {
  it('unlocks only with the exact text and enough time', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const challenge = await startChallenge(service, tab(1, 'https://x.com/home'));
    expect(challenge).toMatchObject({ siteName: 'X', text: 'First sentence.', minDurationSeconds: 20, unlockDurationMinutes: 5 });

    now += 25_000;
    const wrong = await service.completeChallenge(tab(1, 'https://x.com/home'), {
      challengeId: challenge.id,
      typed: 'first sentence.',
      elapsedMs: 21_000,
    });
    expect(wrong).toMatchObject({ ok: false, reason: 'mismatch' });

    const early = await service.completeChallenge(tab(1, 'https://x.com/home'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 19_999,
    });
    expect(early).toMatchObject({ ok: false, reason: 'too-early' });

    // More foreground time than wall-clock time since the challenge started is not plausible.
    const impossible = await service.completeChallenge(tab(1, 'https://x.com/home'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 60_000,
    });
    expect(impossible).toMatchObject({ ok: false, reason: 'too-early' });

    const ok = await service.completeChallenge(tab(1, 'https://x.com/home'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 21_000,
    });
    expect(ok).toEqual({ ok: true, allowedUntil: now + 5 * 60_000 });
    expect(browser.refreshed.at(-1)).toEqual(['x.com', 'twitter.com']);
    expect(await todayStats()).toMatchObject({ opened: 1 });
  });

  it('only accepts completion from the tab that received the challenge', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const challenge = await startChallenge(service, tab(1, 'https://x.com/'));
    now += 30_000;
    const result = await service.completeChallenge(tab(2, 'https://x.com/'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 25_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown-challenge' });
  });

  it('shares the grant between x.com and twitter.com but not with Instagram', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const challenge = await startChallenge(service, tab(1, 'https://x.com/'));
    now += 30_000;
    const { allowedUntil } = (await service.completeChallenge(tab(1, 'https://x.com/'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 25_000,
    })) as { allowedUntil: number };

    expect(await service.getGateState(tab(2, 'https://mobile.twitter.com/explore'))).toMatchObject({
      status: 'allowed',
      allowedUntil,
    });
    expect((await service.getGateState(tab(3, 'https://www.instagram.com/'))).status).toBe('gated');

    // Visiting more pages does not extend the grant; it ends on time.
    now += 60_000;
    expect((await service.startChallenge(tab(4, 'https://x.com/other'))).status).toBe('allowed');
    expect(await service.getGateState(tab(4, 'https://x.com/other'))).toMatchObject({ allowedUntil });
    now = allowedUntil;
    expect((await service.getGateState(tab(4, 'https://x.com/other'))).status).toBe('gated');
  });

  it('serializes concurrent unlocks without double counting or extending', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const a = await startChallenge(service, tab(1, 'https://x.com/'));
    const b = await startChallenge(service, tab(2, 'https://twitter.com/'));
    now += 30_000;
    const [ra, rb] = await Promise.all([
      service.completeChallenge(tab(1, 'https://x.com/'), { challengeId: a.id, typed: a.text, elapsedMs: 25_000 }),
      service.completeChallenge(tab(2, 'https://twitter.com/'), { challengeId: b.id, typed: b.text, elapsedMs: 25_000 }),
    ]);
    expect(ra).toEqual({ ok: true, allowedUntil: now + 300_000 });
    expect(rb).toEqual(ra);
    expect(await todayStats()).toMatchObject({ opened: 1 });

    // Repeating the same completion returns the same grant.
    now += 10_000;
    const again = await service.completeChallenge(tab(1, 'https://x.com/'), { challengeId: a.id, typed: a.text, elapsedMs: 25_000 });
    expect(again).toEqual(ra);
    expect(await todayStats()).toMatchObject({ opened: 1 });
  });

  it('counts shown once per challenge and declined once, never on tab close', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const first = await startChallenge(service, tab(1, 'https://x.com/'));
    expect(await service.markShown(tab(1, 'https://x.com/'), first.id)).toEqual({ ok: true });
    expect(await service.markShown(tab(1, 'https://x.com/'), first.id)).toEqual({ ok: false });
    expect(await service.declineChallenge(tab(1, 'https://x.com/'), first.id)).toEqual({ ok: true });
    expect(await service.declineChallenge(tab(1, 'https://x.com/'), first.id)).toEqual({ ok: true });

    const second = await startChallenge(service, tab(2, 'https://x.com/'));
    await service.markShown(tab(2, 'https://x.com/'), second.id);
    await service.onTabRemoved(2);
    expect(await todayStats()).toMatchObject({ shown: 2, opened: 0, declined: 1 });

    // A declined challenge cannot be used to unlock afterwards.
    now += 30_000;
    const result = await service.completeChallenge(tab(1, 'https://x.com/'), {
      challengeId: first.id,
      typed: first.text,
      elapsedMs: 25_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'closed' });
  });

  it('does not repeat the previous sentence for the same site', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const texts: string[] = [];
    for (let i = 0; i < 4; i += 1) texts.push((await startChallenge(service, tab(1, 'https://x.com/'))).text);
    for (let i = 1; i < texts.length; i += 1) expect(texts[i]).not.toBe(texts[i - 1]);
    // Instagram keeps its own history.
    expect((await startChallenge(service, tab(2, 'https://instagram.com/'))).text).toBe('First sentence.');
  });

  it('keeps conditions captured at challenge start when settings change', async () => {
    const service = makeService();
    await enableBuiltins(service);
    const challenge = await startChallenge(service, tab(1, 'https://x.com/'));
    await service.updateSettings({ minDurationSeconds: 120, unlockDurationMinutes: 30 });
    now += 30_000;
    const result = await service.completeChallenge(tab(1, 'https://x.com/'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 21_000,
    });
    expect(result).toEqual({ ok: true, allowedUntil: now + 5 * 60_000 });
    expect((await startChallenge(service, tab(2, 'https://instagram.com/'))).minDurationSeconds).toBe(120);
  });

  it('keeps grants and challenges across a worker restart', async () => {
    const first = makeService();
    await enableBuiltins(first);
    const challenge = await startChallenge(first, tab(1, 'https://x.com/'));

    const restarted = makeService();
    now += 30_000;
    const result = await restarted.completeChallenge(tab(1, 'https://x.com/'), {
      challengeId: challenge.id,
      typed: challenge.text,
      elapsedMs: 25_000,
    });
    expect(result.ok).toBe(true);
    expect((await makeService().getGateState(tab(5, 'https://x.com/'))).status).toBe('allowed');
  });

  it('drops grants when a site or the extension is turned off, so turning on needs a new challenge', async () => {
    const service = makeService();
    await enableBuiltins(service);
    for (const site of ['x', 'instagram']) {
      const url = site === 'x' ? 'https://x.com/' : 'https://instagram.com/';
      const challenge = await startChallenge(service, tab(1, url));
      now += 30_000;
      await service.completeChallenge(tab(1, url), { challengeId: challenge.id, typed: challenge.text, elapsedMs: 25_000 });
    }

    await service.setSiteEnabled('x', false);
    expect(browser.granted.has('*://*.x.com/*')).toBe(false);
    browser.grant('x.com', 'twitter.com');
    await service.setSiteEnabled('x', true);
    expect((await service.getGateState(tab(1, 'https://x.com/'))).status).toBe('gated');
    expect((await service.getGateState(tab(1, 'https://instagram.com/'))).status).toBe('allowed');

    await service.updateSettings({ enabled: false });
    expect(browser.registered).toEqual([]);
    expect((await service.getGateState(tab(1, 'https://instagram.com/'))).status).toBe('inactive');
    await service.updateSettings({ enabled: true });
    expect((await service.getGateState(tab(1, 'https://instagram.com/'))).status).toBe('gated');
  });
});

describe('settings', () => {
  it('validates timing ranges', async () => {
    const service = makeService();
    expect((await service.updateSettings({ minDurationSeconds: 4 })).ok).toBe(false);
    expect((await service.updateSettings({ minDurationSeconds: 300 })).ok).toBe(true);
    expect((await service.updateSettings({ unlockDurationMinutes: 0 })).ok).toBe(false);
    expect((await service.updateSettings({ unlockDurationMinutes: 1.5 })).ok).toBe(false);
    const result = await service.updateSettings({ unlockDurationMinutes: 60 });
    expect(result.view.settings).toMatchObject({ minDurationSeconds: 300, unlockDurationMinutes: 60 });
  });

  it('adds custom sites, rejects overlaps and removes them with their permission', async () => {
    const service = makeService();
    await enableBuiltins(service);

    const overlap = await service.addSite('https://mobile.twitter.com/home');
    expect(overlap).toMatchObject({ ok: false, error: 'mobile.twitter.com is already covered by X (twitter.com).' });

    const pending = await service.addSite('https://www.reddit.com/r/all');
    expect(pending).toMatchObject({ ok: true, notice: 'Added reddit.com, but it is not protected until you allow access.' });
    expect(pending.view.sites.at(-1)).toMatchObject({ id: 'custom:reddit.com', status: 'off' });
    expect((await service.addSite('old.reddit.com')).ok).toBe(false);

    browser.grant('reddit.com');
    await service.setSiteEnabled('custom:reddit.com', true);
    expect(browser.registered).toEqual(['x', 'instagram', 'custom:reddit.com']);

    expect((await service.removeSite('x')).ok).toBe(false);
    const removed = await service.removeSite('custom:reddit.com');
    expect(removed.ok).toBe(true);
    expect(removed.view.sites.map((s) => s.id)).toEqual(['x', 'instagram']);
    expect(browser.granted.has('*://*.reddit.com/*')).toBe(false);
    expect(browser.registered).toEqual(['x', 'instagram']);
  });
});

describe('message sets', () => {
  it('replaces messages on import, keeps them on failed import and restores the bundled set', async () => {
    const service = makeService();
    await enableBuiltins(service);
    expect((await service.getSettingsView()).corpus).toMatchObject({ source: 'bundled', count: 3 });

    const inProgress = await startChallenge(service, tab(1, 'https://x.com/'));
    const imported = await service.importCorpus('Custom one.\nCustom two.\nCustom one.\n', '/private/path/mine.txt');
    expect(imported).toMatchObject({ ok: true });
    expect(imported.view.corpus).toMatchObject({ source: 'custom', count: 2, fileName: 'mine.txt' });

    const failed = await service.importCorpus('Fine.\nBad ​ line.\n', 'broken.txt');
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toContain('Line 2: unsupported character U+200B');
    expect(failed.view.corpus).toMatchObject({ source: 'custom', count: 2 });

    // The challenge on screen keeps its sentence; new challenges use the new set.
    now += 30_000;
    const done = await service.completeChallenge(tab(1, 'https://x.com/'), {
      challengeId: inProgress.id,
      typed: inProgress.text,
      elapsedMs: 25_000,
    });
    expect(done.ok).toBe(true);
    expect((await startChallenge(service, tab(2, 'https://instagram.com/'))).text).toBe('Custom one.');

    // Restarting the worker keeps the imported set.
    expect((await makeService().getSettingsView()).corpus).toMatchObject({ source: 'custom', count: 2 });

    const restored = await service.restoreBundledCorpus();
    expect(restored.view.corpus).toMatchObject({ source: 'bundled', count: 3 });
    expect(await local.get(LOCAL_KEYS.customCorpus)).toBeUndefined();
    // Changing messages did not cancel the unlock.
    expect((await service.getGateState(tab(1, 'https://x.com/'))).status).toBe('allowed');
  });

  it('reports a missing custom set instead of mixing in bundled messages', async () => {
    const service = makeService();
    await enableBuiltins(service);
    await service.importCorpus('Custom.\n', 'a.txt');
    await local.remove(LOCAL_KEYS.customCorpus);
    const result = await service.startChallenge(tab(1, 'https://x.com/'));
    expect(result.status).toBe('error');
  });

  it('reports an invalid bundled file as an error', async () => {
    browser.bundled = 'Badé\n';
    const service = makeService();
    await enableBuiltins(service);
    const result = await service.startChallenge(tab(1, 'https://x.com/'));
    expect(result).toMatchObject({ status: 'error' });
  });
});
