// Build small tape images in memory for tests.

function withChecksum(bytes: number[]): number[] {
  return [...bytes, bytes.reduce((a, b) => a ^ b, 0)];
}

/** Header + data blocks (flag and checksum included) for an auto-running BASIC program. */
export function basicProgramBlocks(name: string, lines: Array<{ line: number; tokens: number[] }>): number[][] {
  const program: number[] = [];
  for (const { line, tokens } of lines) {
    const body = [...tokens, 0x0d];
    program.push(line >> 8, line & 0xff, body.length & 0xff, body.length >> 8, ...body);
  }
  const autostart = lines[0].line;
  const header = withChecksum([
    0x00, 0x00, ...name.padEnd(10).slice(0, 10).split('').map((c) => c.charCodeAt(0)),
    program.length & 0xff, program.length >> 8,
    autostart & 0xff, autostart >> 8,
    program.length & 0xff, program.length >> 8,
  ]);
  const data = withChecksum([0xff, ...program]);
  return [header, data];
}

export function str(s: string): number[] {
  return s.split('').map((c) => c.charCodeAt(0));
}

export const PRINT = 0xf5;

export function toTap(blocks: number[][]): Uint8Array {
  const out: number[] = [];
  for (const b of blocks) out.push(b.length & 0xff, b.length >> 8, ...b);
  return Uint8Array.from(out);
}

/** TZX with standard-speed (0x10) blocks, or turbo (0x11) blocks using standard timings. */
export function toTzx(blocks: number[][], turbo = false): Uint8Array {
  const out: number[] = [...str('ZXTape!'), 0x1a, 1, 20];
  out.push(0x30, 9, ...str('test tape'));
  for (const b of blocks) {
    if (turbo) {
      const pilotPulses = b[0] < 0x80 ? 8063 : 3223;
      const w = (v: number) => [v & 0xff, v >> 8];
      out.push(0x11, ...w(2168), ...w(667), ...w(735), ...w(855), ...w(1710), ...w(pilotPulses), 8, ...w(1000),
        b.length & 0xff, (b.length >> 8) & 0xff, b.length >> 16, ...b);
    } else {
      out.push(0x10, 0xe8, 0x03, b.length & 0xff, b.length >> 8, ...b);
    }
  }
  return Uint8Array.from(out);
}
