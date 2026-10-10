import { describe, expect, it } from 'vitest';
import { Spectrum } from '../src/emu/machine';
import { parseSna, writeSna } from '../src/emu/snapshot/sna';
import { applySnapshot, captureSnapshot } from '../src/emu/snapshot/snapshot';
import { compress, parseZ80, writeZ80 } from '../src/emu/snapshot/z80format';
import type { ModelId } from '../src/emu/models';
import type { SpectrumKey } from '../src/emu/keyboard';
import { roms, runFrames, type } from './helpers/machine';
import { screenText } from './helpers/screen';

function bootAndType(model: ModelId): Spectrum {
  const m = new Spectrum(model, roms);
  runFrames(m, 100);
  if (model === '128k') {
    type(m, [['CAPS', '6'], ['ENTER']]); // cursor down to 128 BASIC
    runFrames(m, 20);
  }
  // PRINT "HI" (not yet entered). 48K uses keyword entry; 128 BASIC needs it spelled out.
  const print: SpectrumKey[][] = model === '48k' ? [['P']] : [['P'], ['R'], ['I'], ['N'], ['T'], ['SPACE']];
  type(m, [...print, ['SYM', 'P'], ['H'], ['I'], ['SYM', 'P']]);
  if (model === '128k') m.memory.ram[7][123] = 0x42; // exercise a non-default bank
  return m;
}

describe('snapshots', () => {
  for (const model of ['48k', '128k'] as const) {
    for (const [fmt, write, parse] of [['SNA', writeSna, parseSna], ['Z80', writeZ80, parseZ80]] as const) {
      it(`${fmt} round-trips a ${model} machine`, () => {
        const a = bootAndType(model);
        const bytes = write(captureSnapshot(a));
        if (fmt === 'SNA') expect(bytes.length).toBe(model === '48k' ? 49179 : 131103);
        const snap = parse(bytes);
        expect(snap.model).toBe(model);
        const b = new Spectrum(model, roms);
        applySnapshot(b, snap);
        expect(b.cpu.pc).toBe(a.cpu.pc);
        expect(b.cpu.sp).toBe(a.cpu.sp);
        if (model === '128k') expect(b.memory.ram[7][123]).toBe(0x42);
        // Both machines should finish the command identically.
        for (const m of [a, b]) {
          type(m, [['ENTER']]);
          runFrames(m, 10);
        }
        const font = model === '48k' ? roms['48'] : roms['128-1'];
        expect(screenText(b, font)).toEqual(screenText(a, font));
        expect(screenText(b, font).join('\n')).toMatch(/^hi$/m);
      });
    }
  }

  it('compresses runs and lone ED bytes per the Z80 format rules', () => {
    expect(Array.from(compress(Uint8Array.from([1, 1, 1, 1, 1, 2])))).toEqual([0xed, 0xed, 5, 1, 2]);
    expect(Array.from(compress(Uint8Array.from([0xed, 0xed])))).toEqual([0xed, 0xed, 2, 0xed]);
    expect(Array.from(compress(Uint8Array.from([0xed, 0, 0, 0, 0, 0, 0])))).toEqual([0xed, 0, 0xed, 0xed, 5, 0]);
  });
});
