import { BUILTIN_SITES } from './sites';
import type { Settings, SiteRule } from './types';

export const MIN_DURATION_RANGE = { min: 5, max: 300, default: 20 } as const;
export const UNLOCK_DURATION_RANGE = { min: 1, max: 60, default: 5 } as const;

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    enabled: true,
    minDurationSeconds: MIN_DURATION_RANGE.default,
    unlockDurationMinutes: UNLOCK_DURATION_RANGE.default,
    sites: BUILTIN_SITES.map((site) => ({ ...site, domains: [...site.domains] })),
    corpusSource: 'bundled',
  };
}

export function isIntegerInRange(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/**
 * Repairs whatever is in storage into a valid Settings object. Unknown or
 * invalid fields fall back to defaults; built-in sites are always present.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (!raw || typeof raw !== 'object') return defaults;
  const input = raw as Partial<Record<keyof Settings, unknown>>;

  const storedSites = Array.isArray(input.sites) ? input.sites.filter(isSiteRule) : [];
  const sites: SiteRule[] = defaults.sites.map((builtin) => {
    const stored = storedSites.find((site) => site.id === builtin.id);
    return stored ? { ...builtin, enabled: stored.enabled } : builtin;
  });
  for (const site of storedSites) {
    if (site.builtin || sites.some((existing) => existing.id === site.id)) continue;
    sites.push({ ...site, domains: [...site.domains], builtin: false });
  }

  return {
    schemaVersion: 1,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    minDurationSeconds: isIntegerInRange(input.minDurationSeconds, MIN_DURATION_RANGE)
      ? input.minDurationSeconds
      : defaults.minDurationSeconds,
    unlockDurationMinutes: isIntegerInRange(input.unlockDurationMinutes, UNLOCK_DURATION_RANGE)
      ? input.unlockDurationMinutes
      : defaults.unlockDurationMinutes,
    sites,
    corpusSource: input.corpusSource === 'custom' ? 'custom' : 'bundled',
  };
}

function isSiteRule(value: unknown): value is SiteRule {
  if (!value || typeof value !== 'object') return false;
  const site = value as Record<string, unknown>;
  return (
    typeof site.id === 'string' &&
    typeof site.name === 'string' &&
    typeof site.enabled === 'boolean' &&
    Array.isArray(site.domains) &&
    site.domains.length > 0 &&
    site.domains.every((domain) => typeof domain === 'string' && domain.length > 0)
  );
}
