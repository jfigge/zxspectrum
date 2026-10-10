import type { Spectrum } from '../../src/emu/machine';

/** Read the 32x24 text screen by matching each character cell against the ROM font. */
export function screenText(m: Spectrum, font: Uint8Array): string[] {
  const screen = m.memory.ram[m.memory.screenBank];
  const glyphs = new Map<string, string>();
  for (let c = 0x20; c < 0x80; c++) {
    const g = font.subarray(0x3d00 + (c - 0x20) * 8, 0x3d00 + (c - 0x20) * 8 + 8);
    glyphs.set(Array.from(g).join(','), c === 0x7f ? '©' : String.fromCharCode(c));
  }
  const lines: string[] = [];
  for (let row = 0; row < 24; row++) {
    let line = '';
    for (let col = 0; col < 32; col++) {
      const bytes: number[] = [];
      for (let y = 0; y < 8; y++) {
        const py = row * 8 + y;
        bytes.push(screen[((py & 0xc0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | col]);
      }
      const inverse = bytes.map((b) => b ^ 0xff).join(',');
      line += glyphs.get(bytes.join(',')) ?? glyphs.get(inverse) ?? '?';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
