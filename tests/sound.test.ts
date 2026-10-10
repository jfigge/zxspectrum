import { describe, expect, it } from 'vitest';
import { AY } from '../src/emu/ay';
import { Spectrum } from '../src/emu/machine';
import { roms, runFrames, type } from './helpers/machine';

function energy(m: Spectrum, frames: number): number {
  let sum = 0;
  let n = 0;
  for (let f = 0; f < frames; f++) {
    for (const s of m.runFrame()) { sum += s * s; n++; }
  }
  return Math.sqrt(sum / n);
}

/** Count zero crossings of the frame audio to estimate frequency. */
function frequency(m: Spectrum, frames: number, sampleRate: number): number {
  let crossings = 0;
  let prev = 0;
  let n = 0;
  for (let f = 0; f < frames; f++) {
    for (const s of m.runFrame()) {
      if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
      prev = s;
      n++;
    }
  }
  return crossings / 2 / (n / sampleRate);
}

describe('AY-3-8912', () => {
  it('produces a square wave at clock / (16 * period)', () => {
    const ay = new AY();
    ay.reset();
    ay.writeRegister(0, 100); // tone A period 100
    ay.writeRegister(7, 0b111110); // tone A only
    ay.writeRegister(8, 15);
    let toggles = 0;
    let prev = ay.out[0];
    const ticks = 10_000;
    for (let i = 0; i < ticks; i++) {
      ay.tick();
      if (ay.out[0] !== prev) toggles++;
      prev = ay.out[0];
    }
    // One tick = 8 AY clocks; a full cycle is 2 * period ticks.
    expect(toggles).toBe(ticks / 100);
  });

  it('runs envelope shape 13 (attack then hold) up to full volume', () => {
    const ay = new AY();
    ay.reset();
    ay.writeRegister(7, 0b111111); // tone and noise disabled: output follows amplitude
    ay.writeRegister(8, 0x10); // envelope mode
    ay.writeRegister(11, 1);
    ay.writeRegister(13, 13);
    const levels: number[] = [];
    for (let i = 0; i < 64; i++) { ay.tick(); levels.push(ay.out[0]); }
    expect(levels[0]).toBe(0);
    expect(levels[63]).toBe(1);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels); // monotonic rise
  });
});

describe('machine audio', () => {
  it('48K: BEEP 1,0 sounds middle C (~262 Hz)', () => {
    const m = new Spectrum('48k', roms, 48000);
    runFrames(m, 100);
    expect(energy(m, 10)).toBeLessThan(0.01);
    // E mode (CAPS+SYM), SYM+Z = BEEP, then "1,0"
    type(m, [['CAPS', 'SYM'], ['SYM', 'Z'], ['1'], ['SYM', 'N'], ['0'], ['ENTER']]);
    const f = frequency(m, 20, 48000);
    expect(f).toBeGreaterThan(250);
    expect(f).toBeLessThan(275);
  });

  it('128K: PLAY drives the AY', () => {
    const m = new Spectrum('128k', roms, 48000);
    runFrames(m, 100);
    type(m, [['CAPS', '6'], ['ENTER']]); // 128 BASIC
    runFrames(m, 20);
    type(m, [['P'], ['L'], ['A'], ['Y'], ['SPACE'], ['SYM', 'P'], ['C'], ['SYM', 'P'], ['ENTER']]);
    runFrames(m, 5);
    expect(energy(m, 10)).toBeGreaterThan(0.02);
    expect(m.ay!.regs[8] | m.ay!.regs[9] | m.ay!.regs[10]).not.toBe(0);
  });
});
