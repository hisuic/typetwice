/**
 * Accumulates foreground time from clock differences instead of counting
 * interval callbacks. Gaps longer than `maxGapMs` (sleep, frozen tabs,
 * throttled timers) are dropped instead of being added in one piece.
 */
export const MAX_TICK_GAP_MS = 1_500;

export class ForegroundTimer {
  private elapsed = 0;
  private lastCheckpoint: number | null = null;
  private counting = false;

  constructor(
    private readonly now: () => number,
    private readonly maxGapMs = MAX_TICK_GAP_MS,
  ) {}

  /**
   * Adds the time since the previous checkpoint if that interval was counted,
   * then records whether the interval starting now should count.
   */
  checkpoint(counting: boolean): void {
    const now = this.now();
    if (this.counting && this.lastCheckpoint !== null) {
      const delta = now - this.lastCheckpoint;
      if (delta > 0 && delta < this.maxGapMs) this.elapsed += delta;
    }
    this.lastCheckpoint = now;
    this.counting = counting;
  }

  get elapsedMs(): number {
    return this.elapsed;
  }

  get isCounting(): boolean {
    return this.counting;
  }
}
