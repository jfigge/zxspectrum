// General Instrument AY-3-8912 sound chip (128K).
// tick() advances the chip by 8 AY clock cycles (the tone counter rate).

/** Output level for each 4-bit amplitude, from measurements of real chips. */
const VOLUMES = [
  0, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
  0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1.0,
];

/** Bits that are implemented in each register; the rest read back as 0. */
const REGISTER_MASK = [0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff];

export class AY {
  readonly regs = new Uint8Array(16);
  selected = 0;

  private readonly toneCounter = [0, 0, 0];
  private readonly toneOut = [0, 0, 0];
  private noiseCounter = 0;
  private noiseHalf = 0;
  private rng = 1;
  private noiseOut = 0;
  private envCounter = 0;
  private envStep = 0;
  private envAttack = false;
  private envHolding = false;

  /** Per-channel output levels after the last tick (0..1). */
  readonly out = new Float32Array(3);

  reset(): void {
    this.regs.fill(0);
    this.selected = 0;
    this.toneCounter.fill(0);
    this.toneOut.fill(0);
    this.noiseCounter = this.noiseHalf = 0;
    this.rng = 1;
    this.noiseOut = 0;
    this.writeRegister(13, 0);
    this.out.fill(0);
  }

  readRegister(): number {
    return this.regs[this.selected];
  }

  write(v: number): void {
    this.writeRegister(this.selected, v);
  }

  writeRegister(r: number, v: number): void {
    if (r > 15) return;
    this.regs[r] = v & REGISTER_MASK[r];
    if (r === 13) {
      this.envCounter = 0;
      this.envStep = 0;
      this.envAttack = (v & 4) !== 0;
      this.envHolding = false;
    }
  }

  tick(): void {
    const regs = this.regs;
    for (let ch = 0; ch < 3; ch++) {
      const period = (regs[ch * 2] | (regs[ch * 2 + 1] << 8)) || 1;
      if (++this.toneCounter[ch] >= period) {
        this.toneCounter[ch] = 0;
        this.toneOut[ch] ^= 1;
      }
    }

    // Noise runs at half the tone rate.
    this.noiseHalf ^= 1;
    if (this.noiseHalf && ++this.noiseCounter >= (regs[6] || 1)) {
      this.noiseCounter = 0;
      // 17-bit LFSR, taps at bits 0 and 3.
      this.rng = (this.rng >> 1) | (((this.rng ^ (this.rng >> 3)) & 1) << 16);
      this.noiseOut = this.rng & 1;
    }

    // Envelope: 16 steps per ramp, one step every 2*EP ticks.
    if (!this.envHolding) {
      const envPeriod = (regs[11] | (regs[12] << 8)) || 1;
      if (++this.envCounter >= envPeriod * 2) {
        this.envCounter = 0;
        if (++this.envStep > 15) this.envelopeCycleEnd();
      }
    }
    const envVolume = this.envAttack ? this.envStep : 15 - this.envStep;

    const mixer = regs[7];
    for (let ch = 0; ch < 3; ch++) {
      const toneOn = (this.toneOut[ch] | ((mixer >> ch) & 1)) !== 0;
      const noiseOn = (this.noiseOut | ((mixer >> (ch + 3)) & 1)) !== 0;
      const amp = regs[8 + ch];
      this.out[ch] = toneOn && noiseOn ? VOLUMES[amp & 0x10 ? envVolume : amp & 0x0f] : 0;
    }
  }

  private envelopeCycleEnd(): void {
    const shape = this.regs[13];
    const cont = shape & 8;
    const alt = shape & 2;
    const hold = shape & 1;
    if (!cont) {
      this.envAttack = false;
      this.envStep = 15;
      this.envHolding = true;
    } else if (hold) {
      if (alt) this.envAttack = !this.envAttack;
      this.envStep = 15;
      this.envHolding = true;
    } else {
      if (alt) this.envAttack = !this.envAttack;
      this.envStep = 0;
    }
  }
}
