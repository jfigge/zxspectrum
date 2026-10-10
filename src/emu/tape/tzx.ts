import { STANDARD, type GdbSymbol, type Tape, type TapeBlock } from './blocks';

const SIGNATURE = 'ZXTape!\x1a';

class Reader {
  constructor(readonly bytes: Uint8Array, public p = 0) {}
  u8(): number { this.need(1); return this.bytes[this.p++]; }
  u16(): number { this.need(2); const v = this.bytes[this.p] | (this.bytes[this.p + 1] << 8); this.p += 2; return v; }
  s16(): number { return (this.u16() << 16) >> 16; }
  u24(): number { this.need(3); const v = this.bytes[this.p] | (this.bytes[this.p + 1] << 8) | (this.bytes[this.p + 2] << 16); this.p += 3; return v; }
  u32(): number { this.need(4); const v = (this.bytes[this.p] | (this.bytes[this.p + 1] << 8) | (this.bytes[this.p + 2] << 16)) + this.bytes[this.p + 3] * 0x1000000; this.p += 4; return v; }
  take(n: number): Uint8Array { this.need(n); const v = this.bytes.slice(this.p, this.p + n); this.p += n; return v; }
  text(n: number): string { return String.fromCharCode(...this.take(n)); }
  private need(n: number): void {
    if (this.p + n > this.bytes.length) throw new Error(`TZX truncated at offset ${this.p}`);
  }
}

/** Parse a .TZX file (v1.20). Informational blocks are kept as 'info' so jump offsets stay valid. */
export function parseTzx(bytes: Uint8Array, name = 'tape'): Tape {
  if (String.fromCharCode(...bytes.subarray(0, 8)) !== SIGNATURE) throw new Error('Not a TZX file');
  const r = new Reader(bytes, 10);
  const blocks: TapeBlock[] = [];
  while (r.p < bytes.length) {
    const id = r.u8();
    blocks.push(parseBlock(id, r));
  }
  return { name, blocks };
}

function parseBlock(id: number, r: Reader): TapeBlock {
  switch (id) {
    case 0x10: { // Standard speed data
      const pause = r.u16();
      const data = r.take(r.u16());
      return {
        type: 'data', pilot: STANDARD.pilot,
        pilotPulses: data[0] < 0x80 ? STANDARD.headerPilotPulses : STANDARD.dataPilotPulses,
        sync1: STANDARD.sync1, sync2: STANDARD.sync2, zero: STANDARD.zero, one: STANDARD.one,
        data, usedBits: 8, pause,
      };
    }
    case 0x11: { // Turbo speed data
      const pilot = r.u16(), sync1 = r.u16(), sync2 = r.u16(), zero = r.u16(), one = r.u16();
      const pilotPulses = r.u16(), usedBits = r.u8() || 8, pause = r.u16();
      return { type: 'data', pilot, pilotPulses, sync1, sync2, zero, one, usedBits, pause, data: r.take(r.u24()) };
    }
    case 0x12: { // Pure tone
      const length = r.u16();
      return { type: 'tone', length, pulses: r.u16() };
    }
    case 0x13: { // Pulse sequence
      const n = r.u8();
      const lengths: number[] = [];
      for (let i = 0; i < n; i++) lengths.push(r.u16());
      return { type: 'pulses', lengths };
    }
    case 0x14: { // Pure data
      const zero = r.u16(), one = r.u16(), usedBits = r.u8() || 8, pause = r.u16();
      return { type: 'data', pilot: 0, pilotPulses: 0, sync1: 0, sync2: 0, zero, one, usedBits, pause, data: r.take(r.u24()) };
    }
    case 0x15: { // Direct recording
      const tPerSample = r.u16(), pause = r.u16(), usedBits = r.u8() || 8;
      return { type: 'direct', tPerSample, pause, usedBits, data: r.take(r.u24()) };
    }
    case 0x18: return parseCsw(r);
    case 0x19: return parseGeneralized(r);
    case 0x20: return { type: 'pause', ms: r.u16() };
    case 0x21: return { type: 'info', text: `Group: ${r.text(r.u8())}` };
    case 0x22: return { type: 'info', text: 'Group end' };
    case 0x23: return { type: 'jump', offset: r.s16() };
    case 0x24: return { type: 'loopStart', count: r.u16() };
    case 0x25: return { type: 'loopEnd' };
    case 0x26: {
      const n = r.u16();
      const offsets: number[] = [];
      for (let i = 0; i < n; i++) offsets.push(r.s16());
      return { type: 'call', offsets };
    }
    case 0x27: return { type: 'return' };
    case 0x28: r.take(r.u16()); return { type: 'info', text: 'Select block' };
    case 0x2a: r.u32(); return { type: 'stop48' };
    case 0x2b: r.u32(); return { type: 'setLevel', level: r.u8() & 1 };
    case 0x30: return { type: 'info', text: r.text(r.u8()) };
    case 0x31: r.u8(); return { type: 'info', text: r.text(r.u8()) };
    case 0x32: r.take(r.u16()); return { type: 'info', text: 'Archive info' };
    case 0x33: r.take(r.u8() * 3); return { type: 'info', text: 'Hardware type' };
    case 0x35: r.take(10); r.take(r.u32()); return { type: 'info', text: 'Custom info' };
    case 0x5a: r.take(9); return { type: 'info', text: 'Glue' };
    // Deprecated blocks.
    case 0x16: case 0x17: r.take(r.u32()); return { type: 'info', text: `Unsupported block 0x${id.toString(16)}` };
    case 0x34: r.take(8); return { type: 'info', text: 'Emulation info' };
    case 0x40: r.take(r.u24()); return { type: 'info', text: 'Snapshot block' };
    default:
      // TZX 1.10+: unknown blocks start with a 32-bit length.
      r.take(r.u32());
      return { type: 'info', text: `Unknown block 0x${id.toString(16)}` };
  }
}

/** Block 0x18 (CSW recording). Only RLE compression is supported. */
function parseCsw(r: Reader): TapeBlock {
  const length = r.u32();
  const end = r.p + length;
  const pause = r.u16();
  const sampleRate = r.u24();
  const compression = r.u8();
  const pulseCount = r.u32();
  const data = r.take(end - r.p);
  if (compression !== 1) return { type: 'info', text: 'Z-RLE CSW block (unsupported)' };
  const tPerSample = 3_500_000 / sampleRate;
  const pulses: number[] = [];
  for (let i = 0; i < data.length && pulses.length < pulseCount; ) {
    let n = data[i++];
    if (n === 0) {
      n = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
      i += 4;
    }
    pulses.push(Math.round(n * tPerSample));
  }
  return { type: 'csw', pulses, pause };
}

/** Block 0x19 (generalized data). */
function parseGeneralized(r: Reader): TapeBlock {
  const length = r.u32();
  const end = r.p + length;
  const pause = r.u16();
  const totp = r.u32(), npp = r.u8(), asp = r.u8() || 256;
  const totd = r.u32(), npd = r.u8(), asd = r.u8() || 256;
  const readSymbols = (count: number, maxPulses: number): GdbSymbol[] => {
    const out: GdbSymbol[] = [];
    for (let i = 0; i < count; i++) {
      const flags = r.u8() & 3;
      const pulses: number[] = [];
      for (let j = 0; j < maxPulses; j++) pulses.push(r.u16());
      const zero = pulses.indexOf(0);
      out.push({ flags, pulses: zero >= 0 ? pulses.slice(0, zero) : pulses });
    }
    return out;
  };
  let pilotSymbols: GdbSymbol[] = [];
  const pilotStream: Array<{ symbol: number; repeat: number }> = [];
  if (totp > 0) {
    pilotSymbols = readSymbols(asp, npp);
    for (let i = 0; i < totp; i++) {
      const symbol = r.u8();
      pilotStream.push({ symbol, repeat: r.u16() });
    }
  }
  let dataSymbols: GdbSymbol[] = [];
  const dataStream: number[] = [];
  if (totd > 0) {
    dataSymbols = readSymbols(asd, npd);
    const bitsPerSymbol = Math.ceil(Math.log2(asd)) || 1;
    const bytes = r.take(Math.ceil((totd * bitsPerSymbol) / 8));
    for (let i = 0; i < totd; i++) {
      let sym = 0;
      for (let b = 0; b < bitsPerSymbol; b++) {
        const bit = i * bitsPerSymbol + b;
        sym = (sym << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      dataStream.push(sym);
    }
  }
  r.p = end;
  return { type: 'generalized', pause, pilotSymbols, pilotStream, dataSymbols, dataStream };
}
