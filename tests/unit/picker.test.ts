import { describe, expect, it } from 'vitest';
import { pickMessage } from '../../src/core/picker';

const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('pickMessage', () => {
  it('always returns the only message, even if it was picked last time', () => {
    expect(pickMessage(['Only.'], 'Only.')).toBe('Only.');
    expect(pickMessage(['Only.'], undefined)).toBe('Only.');
  });

  it('never repeats the previous message when there are two or more', () => {
    const messages = ['A', 'B'];
    for (let i = 0; i < 50; i += 1) {
      expect(pickMessage(messages, 'A')).toBe('B');
      expect(pickMessage(messages, 'B')).toBe('A');
    }
  });

  it('chooses uniformly among the remaining messages', () => {
    const messages = ['A', 'B', 'C', 'D'];
    const picked = [0, 0.34, 0.67, 0.99].map((r) => pickMessage(messages, 'B', () => r));
    expect(picked).toEqual(['A', 'C', 'D', 'D']);
    expect([0, 0.25, 0.5, 0.75].map((r) => pickMessage(messages, undefined, () => r))).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('treats a previous message that is no longer in the set as absent', () => {
    expect(pickMessage(['A', 'B', 'C'], 'Z', sequence(0.99))).toBe('C');
  });

  it('stays in range when the random source returns 1', () => {
    expect(pickMessage(['A', 'B', 'C'], 'A', () => 1)).toBe('C');
  });

  it('rejects an empty set', () => {
    expect(() => pickMessage([], undefined)).toThrow();
  });
});
