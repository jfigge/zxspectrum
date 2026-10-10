import { describe, expect, it } from 'vitest';
import { Spectrum } from '../src/emu/machine';
import { roms, runFrames, type } from './helpers/machine';
import { screenText } from './helpers/screen';

describe('48K', () => {
  it('boots to the copyright message', () => {
    const m = new Spectrum('48k', roms);
    runFrames(m, 100);
    const text = screenText(m, roms['48']);
    expect(text[23]).toBe('© 1982 Sinclair Research Ltd');
  });

  it('evaluates PRINT 2+2', () => {
    const m = new Spectrum('48k', roms);
    runFrames(m, 100);
    // P = PRINT keyword in K mode; Symbol Shift + K = '+'
    type(m, [['P'], ['2'], ['SYM', 'K'], ['2'], ['ENTER']]);
    runFrames(m, 10);
    const text = screenText(m, roms['48']);
    expect(text[0]).toBe('4');
    expect(text[23]).toBe('0 OK, 0:1');
  });
});

describe('128K', () => {
  it('boots to the menu', () => {
    const m = new Spectrum('128k', roms);
    runFrames(m, 100);
    const text = screenText(m, roms['128-1']).join('\n');
    expect(text).toMatch(/Tape Loader/);
    expect(text).toMatch(/128 BASIC/);
  });
});
