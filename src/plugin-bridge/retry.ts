// Exponential backoff for TCP reconnection to the UE Editor plugin.
// Delay doubles from 1s initial, capped at 30s to avoid reconnect storms.
// See: RESEARCH.md Pitfall 3 — TCP Reconnect Storm on Plugin Not Running

export class ExponentialBackoff {
  private delay: number = 1000;
  private readonly maxDelay: number = 30000;

  /**
   * Returns the current delay in milliseconds, then doubles it for next call.
   * Delay is capped at maxDelay (30000ms).
   */
  nextDelay(): number {
    const current = this.delay;
    this.delay = Math.min(this.delay * 2, this.maxDelay);
    return current;
  }

  /**
   * Resets delay back to the initial value (1000ms).
   * Call this when a connection succeeds.
   */
  reset(): void {
    this.delay = 1000;
  }
}
