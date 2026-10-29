import { describe, expect, it } from 'vitest';
import { defaultSettings, sanitizeSettings } from '../../src/core/settings';

describe('defaultSettings', () => {
  it('uses the initial product defaults with built-in sites turned off', () => {
    const settings = defaultSettings();
    expect(settings).toMatchObject({
      schemaVersion: 1,
      enabled: true,
      minDurationSeconds: 20,
      unlockDurationMinutes: 5,
      corpusSource: 'bundled',
    });
    expect(settings.sites.map((s) => [s.id, s.enabled])).toEqual([
      ['x', false],
      ['instagram', false],
    ]);
  });

  it('returns fresh copies', () => {
    const a = defaultSettings();
    a.sites[0]!.domains.push('changed.example');
    expect(defaultSettings().sites[0]!.domains).toEqual(['x.com', 'twitter.com']);
  });
});

describe('sanitizeSettings', () => {
  it('falls back to defaults for missing or invalid data', () => {
    expect(sanitizeSettings(undefined)).toEqual(defaultSettings());
    expect(
      sanitizeSettings({ enabled: 'yes', minDurationSeconds: 4, unlockDurationMinutes: 2.5, corpusSource: 'x' }),
    ).toEqual(defaultSettings());
    expect(sanitizeSettings({ minDurationSeconds: 301, unlockDurationMinutes: 61 })).toMatchObject({
      minDurationSeconds: 20,
      unlockDurationMinutes: 5,
    });
  });

  it('keeps valid values at the edges of the ranges', () => {
    expect(sanitizeSettings({ minDurationSeconds: 5, unlockDurationMinutes: 60 })).toMatchObject({
      minDurationSeconds: 5,
      unlockDurationMinutes: 60,
    });
  });

  it('keeps built-in site states but not edits to their domains', () => {
    const settings = sanitizeSettings({
      sites: [{ id: 'x', name: 'Hacked', domains: ['evil.example'], enabled: true, builtin: true }],
    });
    expect(settings.sites[0]).toEqual({
      id: 'x',
      name: 'X',
      domains: ['x.com', 'twitter.com'],
      enabled: true,
      builtin: true,
    });
    expect(settings.sites).toHaveLength(2);
  });

  it('keeps valid custom sites and drops malformed ones', () => {
    const settings = sanitizeSettings({
      corpusSource: 'custom',
      sites: [
        { id: 'custom:reddit.com', name: 'reddit.com', domains: ['reddit.com'], enabled: true, builtin: false },
        { id: 'broken', name: 'b', domains: [], enabled: true },
        'nonsense',
      ],
    });
    expect(settings.corpusSource).toBe('custom');
    expect(settings.sites.map((s) => s.id)).toEqual(['x', 'instagram', 'custom:reddit.com']);
  });
});
