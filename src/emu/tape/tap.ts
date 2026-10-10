import { STANDARD, type Tape, type TapeBlock } from './blocks';

/** Parse a .TAP file: a sequence of [length LE16][flag + data + checksum] blocks. */
export function parseTap(bytes: Uint8Array, name = 'tape'): Tape {
  const blocks: TapeBlock[] = [];
  let p = 0;
  while (p + 2 <= bytes.length) {
    const len = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    if (p + len > bytes.length) throw new Error(`TAP block at offset ${p - 2} runs past end of file`);
    const data = bytes.slice(p, p + len);
    p += len;
    blocks.push({
      type: 'data',
      pilot: STANDARD.pilot,
      pilotPulses: data[0] < 0x80 ? STANDARD.headerPilotPulses : STANDARD.dataPilotPulses,
      sync1: STANDARD.sync1,
      sync2: STANDARD.sync2,
      zero: STANDARD.zero,
      one: STANDARD.one,
      data,
      usedBits: 8,
      pause: 1000,
    });
  }
  return { name, blocks };
}
