// Mixes the beeper, tape EAR signal and AY into PCM samples, integrating each
// source over the exact T-states it was active (box-filter resampling).

import type { AY } from './ay';

/** T-states per AY tick: the AY is clocked at CPU/2, and ticks every 8 AY cycles. */
const AY_TICK = 16;

export class SoundMixer {
  readonly tPerSample: number;
  private readonly buffer: Float32Array;
  private count = 0;
  private lastT = 0;
  private nextSampleT: number;
  private nextAyT = AY_TICK;
  private accum = 0;
  private level = 0;
  private ayLevel = 0;
  private beeperLevel = 0;
  private tapeLevel = 0;
  // DC blocking filter state.
  private prevIn = 0;
  private prevOut = 0;

  constructor(cpuHz: number, readonly sampleRate: number, frameLength: number, private readonly ay: AY | null) {
    this.tPerSample = cpuHz / sampleRate;
    this.nextSampleT = this.tPerSample;
    this.buffer = new Float32Array(Math.ceil(frameLength / this.tPerSample) + 4);
  }

  /** Port 0xFE write: bit 4 drives the speaker, bit 3 (MIC) leaks in slightly. */
  setBeeper(t: number, portValue: number): void {
    const level = (portValue & 0x10 ? 0.5 : 0) + (portValue & 0x08 ? 0.05 : 0);
    if (level === this.beeperLevel) return;
    this.update(t);
    this.beeperLevel = level;
    this.level = this.beeperLevel + this.tapeLevel;
  }

  /** Tape EAR input is audible through the speaker while loading. */
  setTape(t: number, ear: number): void {
    const level = ear ? 0.1 : 0;
    if (level === this.tapeLevel) return;
    this.update(t);
    this.tapeLevel = level;
    this.level = this.beeperLevel + this.tapeLevel;
  }

  /** Bring the AY output up to date before a register write. */
  update(t: number): void {
    const ay = this.ay;
    while (this.lastT < t) {
      let next = t < this.nextSampleT ? t : this.nextSampleT;
      if (ay && this.nextAyT < next) next = this.nextAyT;
      this.accum += (next - this.lastT) * (this.level + this.ayLevel);
      this.lastT = next;
      if (next >= this.nextSampleT) {
        if (this.count < this.buffer.length) this.buffer[this.count++] = this.accum / this.tPerSample;
        this.accum = 0;
        this.nextSampleT += this.tPerSample;
      }
      if (ay && next >= this.nextAyT) {
        ay.tick();
        this.ayLevel = (ay.out[0] + ay.out[1] + ay.out[2]) * 0.25;
        this.nextAyT += AY_TICK;
      }
    }
  }

  /** Complete the frame; returns this frame's samples (a view, valid until the next frame). */
  endFrame(frameLength: number): Float32Array {
    this.update(frameLength);
    this.lastT -= frameLength;
    this.nextSampleT -= frameLength;
    this.nextAyT -= frameLength;
    const out = this.buffer.subarray(0, this.count);
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = x - this.prevIn + 0.995 * this.prevOut;
      this.prevIn = x;
      this.prevOut = y;
      out[i] = y * 0.6;
    }
    this.count = 0;
    return out;
  }
}
