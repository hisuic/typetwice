import { describe, expect, it } from 'vitest';
import { corpusVersion, fnv1a32 } from '../../src/core/hash';

describe('corpus version', () => {
  it('matches the reference FNV-1a values', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
  });

  it('changes when messages, their order or the source change', () => {
    const base = corpusVersion('custom', ['A.', 'B.']);
    expect(corpusVersion('custom', ['A.', 'B.'])).toBe(base);
    expect(corpusVersion('custom', ['B.', 'A.'])).not.toBe(base);
    expect(corpusVersion('custom', ['A.', 'B.', 'C.'])).not.toBe(base);
    expect(corpusVersion('bundled', ['A.', 'B.'])).not.toBe(base);
  });
});
