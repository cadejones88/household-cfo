/**
 * The auto-shutter's "hold still" detector: watches accelerometer samples and says when the phone has been
 * steady long enough. Pure so it can be unit-tested; the camera screen feeds it expo-sensors samples.
 */
export interface SteadyOptions {
  /** Change in acceleration magnitude (in g) below which a sample counts as still. */
  threshold?: number;
  /** How many consecutive still samples are needed. */
  samples?: number;
  /** Earliest time a capture may fire, so the camera has settled and the person has aimed. */
  notBeforeMs?: number;
}

export class SteadyDetector {
  private last: { x: number; y: number; z: number } | undefined;
  private still = 0;
  private fired = false;
  private readonly threshold: number;
  private readonly needed: number;
  private readonly delayMs: number;
  private notBefore: number;

  constructor(startedAt: number, opts: SteadyOptions = {}) {
    this.threshold = opts.threshold ?? 0.035;
    this.needed = opts.samples ?? 12;
    this.delayMs = opts.notBeforeMs ?? 2500;
    this.notBefore = startedAt + this.delayMs;
  }

  /** Feed one sample; returns true exactly once, when the phone has been steady long enough. */
  sample(s: { x: number; y: number; z: number }, at: number): boolean {
    if (this.fired) return false;
    if (this.last) {
      const d = Math.abs(s.x - this.last.x) + Math.abs(s.y - this.last.y) + Math.abs(s.z - this.last.z);
      this.still = d < this.threshold ? this.still + 1 : 0;
    }
    this.last = s;
    if (at >= this.notBefore && this.still >= this.needed) {
      this.fired = true;
      return true;
    }
    return false;
  }

  reset(at: number): void {
    this.still = 0;
    this.fired = false;
    this.last = undefined;
    this.notBefore = at + this.delayMs;
  }
}
