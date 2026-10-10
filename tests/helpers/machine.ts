import { Spectrum, type Roms } from '../../src/emu/machine';
import type { SpectrumKey } from '../../src/emu/keyboard';
import { rom } from './fixtures';

export const roms: Roms = { '48': rom('48.rom'), '128-0': rom('128-0.rom'), '128-1': rom('128-1.rom') };

export function runFrames(m: Spectrum, n: number): void {
  for (let i = 0; i < n; i++) m.runFrame();
}

export function type(m: Spectrum, keys: SpectrumKey[][]): void {
  for (const combo of keys) {
    combo.forEach((k) => m.keyboard.press(k));
    runFrames(m, 4);
    combo.forEach((k) => m.keyboard.release(k));
    runFrames(m, 4);
  }
}
