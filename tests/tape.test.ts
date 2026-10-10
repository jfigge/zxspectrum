import { describe, expect, it } from 'vitest';
import { Spectrum } from '../src/emu/machine';
import type { ModelId } from '../src/emu/models';
import { parseTap } from '../src/emu/tape/tap';
import { parseTzx } from '../src/emu/tape/tzx';
import type { Tape } from '../src/emu/tape/blocks';
import { TapePlayer } from '../src/emu/tape/player';
import { roms, runFrames } from './helpers/machine';
import { screenText } from './helpers/screen';
import { PRINT, basicProgramBlocks, str, toTap, toTzx } from './helpers/tapes';

const blocks = basicProgramBlocks('hello', [{ line: 10, tokens: [PRINT, ...str('"HELLO"')] }]);

function loadAndRun(model: ModelId, tape: Tape, fastLoad: boolean, maxFrames: number): { text: string[]; frames: number } {
  const m = new Spectrum(model, roms);
  m.fastLoad = fastLoad;
  m.insertTape(tape);
  m.autoLoad();
  const font = model === '48k' ? roms['48'] : roms['128-1'];
  for (let f = 0; f < maxFrames; f += 10) {
    runFrames(m, 10);
    const text = screenText(m, font);
    if (text.includes('HELLO')) return { text, frames: f + 10 };
  }
  return { text: screenText(m, font), frames: maxFrames };
}

describe('TAP parsing', () => {
  it('splits blocks', () => {
    const tape = parseTap(toTap(blocks));
    expect(tape.blocks).toHaveLength(2);
    expect(tape.blocks[0]).toMatchObject({ type: 'data', pilotPulses: 8063 });
    expect(tape.blocks[1]).toMatchObject({ type: 'data', pilotPulses: 3223 });
  });
});

describe('TZX parsing', () => {
  it('reads standard and turbo blocks', () => {
    const std = parseTzx(toTzx(blocks));
    expect(std.blocks.map((b) => b.type)).toEqual(['info', 'data', 'data']);
    const turbo = parseTzx(toTzx(blocks, true));
    expect(turbo.blocks[2]).toMatchObject({ type: 'data', pilot: 2168, one: 1710, usedBits: 8 });
  });

  it('handles loops, pure tones and pulse sequences', () => {
    const bytes = Uint8Array.from([
      ...str('ZXTape!'), 0x1a, 1, 20,
      0x24, 3, 0, // loop x3
      0x12, 100, 0, 2, 0, // tone: 2 pulses of 100T
      0x25, // loop end
      0x13, 2, 50, 0, 60, 0, // pulses 50, 60
    ]);
    const tape = parseTzx(bytes);
    const player = new TapePlayer(() => true);
    player.insert(tape);
    player.play(0);
    const edges: number[] = [];
    let level = player.level;
    for (let t = 0; t < 2000; t++) {
      const l = player.advance(t);
      if (l !== level) { edges.push(t); level = l; }
    }
    // 6 tone edges at 100T spacing, then 2 pulse edges.
    expect(edges).toEqual([0, 100, 200, 300, 400, 500, 600, 650]);
  });
});

describe('tape loading', () => {
  it('fast-loads a TAP on the 48K', () => {
    const { text, frames } = loadAndRun('48k', parseTap(toTap(blocks)), true, 400);
    expect(text).toContain('HELLO');
    expect(frames).toBeLessThan(200);
  });

  it('loads a TAP in real time on the 48K', () => {
    const { text } = loadAndRun('48k', parseTap(toTap(blocks)), false, 1500);
    expect(text).toContain('HELLO');
  });

  it('loads a turbo-block TZX in real time on the 48K', () => {
    const { text } = loadAndRun('48k', parseTzx(toTzx(blocks, true)), false, 1500);
    expect(text).toContain('HELLO');
  });

  it('fast-loads a TZX on the 128K', () => {
    const { text } = loadAndRun('128k', parseTzx(toTzx(blocks)), true, 400);
    expect(text).toContain('HELLO');
  });

  it('loads a TAP in real time on the 128K', () => {
    const { text } = loadAndRun('128k', parseTap(toTap(blocks)), false, 1500);
    expect(text).toContain('HELLO');
  });
});
