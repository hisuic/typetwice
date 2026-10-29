import type { GrantMap } from './types';

export function isAllowed(allowedUntil: number | undefined, now: number): boolean {
  return allowedUntil !== undefined && now < allowedUntil;
}

export function computeAllowedUntil(now: number, unlockDurationMinutes: number): number {
  return now + unlockDurationMinutes * 60_000;
}

/**
 * Returns the grant that results from a successful unlock. An unexpired
 * grant is returned unchanged so that concurrent unlocks never extend it.
 */
export function resolveGrant(
  existing: number | undefined,
  now: number,
  unlockDurationMinutes: number,
): { allowedUntil: number; created: boolean } {
  if (existing !== undefined && isAllowed(existing, now)) {
    return { allowedUntil: existing, created: false };
  }
  return { allowedUntil: computeAllowedUntil(now, unlockDurationMinutes), created: true };
}

export function pruneGrants(grants: GrantMap, now: number): GrantMap {
  const result: GrantMap = {};
  for (const [siteId, allowedUntil] of Object.entries(grants)) {
    if (isAllowed(allowedUntil, now)) result[siteId] = allowedUntil;
  }
  return result;
}
