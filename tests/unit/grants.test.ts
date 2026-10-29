import { describe, expect, it } from 'vitest';
import { computeAllowedUntil, isAllowed, pruneGrants, resolveGrant } from '../../src/core/grants';

const T = 1_700_000_000_000;

describe('grants', () => {
  it('computes the expiry in wall-clock minutes from the unlock', () => {
    expect(computeAllowedUntil(T, 5)).toBe(T + 300_000);
  });

  it('is allowed strictly before the expiry', () => {
    const until = computeAllowedUntil(T, 5);
    expect(isAllowed(until, T)).toBe(true);
    expect(isAllowed(until, until - 1)).toBe(true);
    expect(isAllowed(until, until)).toBe(false);
    expect(isAllowed(undefined, T)).toBe(false);
  });

  it('returns an existing grant unchanged instead of extending it', () => {
    const existing = T + 120_000;
    expect(resolveGrant(existing, T, 5)).toEqual({ allowedUntil: existing, created: false });
  });

  it('creates a new grant when the previous one has expired or is missing', () => {
    expect(resolveGrant(T - 1, T, 5)).toEqual({ allowedUntil: T + 300_000, created: true });
    expect(resolveGrant(undefined, T, 1)).toEqual({ allowedUntil: T + 60_000, created: true });
  });

  it('prunes expired grants', () => {
    expect(pruneGrants({ x: T + 1, instagram: T, other: T - 5 }, T)).toEqual({ x: T + 1 });
  });
});
