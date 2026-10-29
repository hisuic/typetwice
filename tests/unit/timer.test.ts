import { describe, expect, it } from 'vitest';
import { ForegroundTimer } from '../../src/core/timer';

function setup() {
  let now = 1_000;
  const timer = new ForegroundTimer(() => now);
  return {
    timer,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('ForegroundTimer', () => {
  it('starts at zero and does not count before the first counting checkpoint', () => {
    const { timer, advance } = setup();
    advance(5_000);
    timer.checkpoint(false);
    advance(5_000);
    timer.checkpoint(true);
    expect(timer.elapsedMs).toBe(0);
  });

  it('adds clock differences between counting checkpoints', () => {
    const { timer, advance } = setup();
    timer.checkpoint(true);
    for (let i = 0; i < 8; i += 1) {
      advance(250);
      timer.checkpoint(true);
    }
    expect(timer.elapsedMs).toBe(2_000);
  });

  it('measures elapsed time, not the number of ticks', () => {
    const { timer, advance } = setup();
    timer.checkpoint(true);
    advance(1_200); // a single throttled tick
    timer.checkpoint(true);
    expect(timer.elapsedMs).toBe(1_200);
  });

  it('pauses while not in the foreground and keeps the total', () => {
    const { timer, advance } = setup();
    timer.checkpoint(true);
    advance(500);
    timer.checkpoint(false); // focus left: the 500 ms before it still count
    advance(60_000);
    timer.checkpoint(false);
    advance(10_000);
    timer.checkpoint(true); // focus returned
    advance(300);
    timer.checkpoint(true);
    expect(timer.elapsedMs).toBe(800);
  });

  it('drops long gaps such as sleep instead of adding them', () => {
    const { timer, advance } = setup();
    timer.checkpoint(true);
    advance(250);
    timer.checkpoint(true);
    advance(3_600_000); // the machine slept with the gate focused
    timer.checkpoint(true);
    advance(1_499);
    timer.checkpoint(true);
    advance(1_500);
    timer.checkpoint(true);
    expect(timer.elapsedMs).toBe(250 + 1_499);
  });

  it('ignores a clock that goes backwards', () => {
    const { timer, advance } = setup();
    timer.checkpoint(true);
    advance(-100);
    timer.checkpoint(true);
    expect(timer.elapsedMs).toBe(0);
  });
});
