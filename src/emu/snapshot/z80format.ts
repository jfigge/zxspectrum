// .Z80 snapshots, versions 1, 2 and 3 (load); version 3 (save).
import type { ModelId } from '../models';
import { blankCpuState, type Snapshot } from './snapshot';

const BANK = 0x4000;

function decompress(src: Uint8Array, outLength: number): Uint8Array {
  const out = new Uint8Array(outLength);
  let o = 0;
  for (let i = 0; i < src.length && o < outLength; ) {
    if (src[i] === 0xed && src[i + 1] === 0xed) {
      const count = src[i + 2];
      const v = src[i + 3];
      for (let n = 0; n < count && o < outLength; n++) out[o++] = v;
      i += 4;
    } else {
      out[o++] = src[i++];
    }
  }
  return out;
}

export function compress(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < src.length; ) {
    const b = src[i];
    let run = 1;
    while (i + run < src.length && src[i + run] === b && run < 255) run++;
    if (run >= 5 || (b === 0xed && run >= 2)) {
      out.push(0xed, 0xed, run, b);
      i += run;
    } else {
      out.push(b);
      i++;
      // A byte following a single ED is never the start of a compressed block.
      if (b === 0xed && i < src.length) out.push(src[i++]);
    }
  }
  return Uint8Array.from(out);
}

function modelFor(version: number, hw: number): ModelId {
  if (version === 2) return hw >= 3 ? '128k' : '48k';
  return hw >= 4 ? '128k' : '48k';
}

export function parseZ80(bytes: Uint8Array): Snapshot {
  if (bytes.length < 30) throw new Error('File too short for a .Z80 snapshot');
  const w = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const cpu = blankCpuState();
  cpu.a = bytes[0]; cpu.f = bytes[1];
  cpu.c = bytes[2]; cpu.b = bytes[3];
  cpu.l = bytes[4]; cpu.h = bytes[5];
  cpu.pc = w(6);
  cpu.sp = w(8);
  cpu.i = bytes[10];
  let flags = bytes[12];
  if (flags === 0xff) flags = 1;
  cpu.r = (bytes[11] & 0x7f) | ((flags & 1) << 7);
  const border = (flags >> 1) & 7;
  cpu.e = bytes[13]; cpu.d = bytes[14];
  cpu.bc_ = w(15); cpu.de_ = w(17); cpu.hl_ = w(19);
  cpu.af_ = (bytes[21] << 8) | bytes[22];
  cpu.iy = w(23); cpu.ix = w(25);
  cpu.iff1 = bytes[27] ? 1 : 0;
  cpu.iff2 = bytes[28] ? 1 : 0;
  cpu.im = bytes[29] & 3;

  const ram = new Map<number, Uint8Array>();

  if (cpu.pc !== 0) {
    // Version 1: 48K only, memory from 0x4000.
    const body = bytes.subarray(30);
    let mem: Uint8Array;
    if (flags & 0x20) {
      const end = body.length >= 4 && body[body.length - 4] === 0 && body[body.length - 3] === 0xed &&
        body[body.length - 2] === 0xed && body[body.length - 1] === 0 ? body.length - 4 : body.length;
      mem = decompress(body.subarray(0, end), 3 * BANK);
    } else {
      mem = body.slice(0, 3 * BANK);
    }
    ram.set(5, mem.slice(0, BANK));
    ram.set(2, mem.slice(BANK, 2 * BANK));
    ram.set(0, mem.slice(2 * BANK, 3 * BANK));
    return { model: '48k', cpu, ram, border, port7ffd: 0 };
  }

  const extLength = w(30);
  const version = extLength === 23 ? 2 : 3;
  cpu.pc = w(32);
  const hw = bytes[34];
  const model = modelFor(version, hw);
  const port7ffd = model === '128k' ? bytes[35] : 0;
  const ay = model === '128k' ? { selected: bytes[38] & 0x0f, regs: bytes.slice(39, 55) } : undefined;

  let p = 32 + extLength;
  while (p + 3 <= bytes.length) {
    const len = w(p);
    const page = bytes[p + 2];
    p += 3;
    const raw = len === 0xffff;
    const data = raw ? bytes.slice(p, p + BANK) : decompress(bytes.subarray(p, p + len), BANK);
    p += raw ? BANK : len;
    let bank: number | undefined;
    if (model === '48k') bank = ({ 8: 5, 4: 2, 5: 0 } as Record<number, number>)[page];
    else if (page >= 3 && page <= 10) bank = page - 3;
    if (bank !== undefined) ram.set(bank, data);
  }
  for (const b of model === '48k' ? [5, 2, 0] : [0, 1, 2, 3, 4, 5, 6, 7]) {
    if (!ram.has(b)) ram.set(b, new Uint8Array(BANK));
  }
  return { model, cpu, ram, border, port7ffd, ay };
}

export function writeZ80(s: Snapshot): Uint8Array {
  const c = s.cpu;
  const header = new Uint8Array(86);
  const w = (o: number, v: number) => { header[o] = v & 0xff; header[o + 1] = (v >> 8) & 0xff; };
  header[0] = c.a; header[1] = c.f;
  header[2] = c.c; header[3] = c.b;
  header[4] = c.l; header[5] = c.h;
  w(6, 0); // PC = 0 marks version 2+
  w(8, c.sp);
  header[10] = c.i;
  header[11] = c.r & 0x7f;
  header[12] = ((c.r >> 7) & 1) | ((s.border & 7) << 1);
  header[13] = c.e; header[14] = c.d;
  w(15, c.bc_); w(17, c.de_); w(19, c.hl_);
  header[21] = c.af_ >> 8; header[22] = c.af_ & 0xff;
  w(23, c.iy); w(25, c.ix);
  header[27] = c.iff1; header[28] = c.iff2;
  header[29] = c.im & 3;
  w(30, 54);
  w(32, c.pc);
  header[34] = s.model === '128k' ? 4 : 0;
  header[35] = s.model === '128k' ? s.port7ffd : 0;
  if (s.ay) {
    header[37] = 0x04; // AY in use
    header[38] = s.ay.selected;
    header.set(s.ay.regs.subarray(0, 16), 39);
  }

  const pages: Array<[page: number, bank: number]> = s.model === '128k'
    ? [0, 1, 2, 3, 4, 5, 6, 7].map((b) => [b + 3, b])
    : [[8, 5], [4, 2], [5, 0]];
  const chunks: Uint8Array[] = [header];
  for (const [page, bank] of pages) {
    const packed = compress(s.ram.get(bank)!);
    const useRaw = packed.length >= BANK;
    const h = new Uint8Array(3);
    const len = useRaw ? 0xffff : packed.length;
    h[0] = len & 0xff; h[1] = len >> 8; h[2] = page;
    chunks.push(h, useRaw ? s.ram.get(bank)! : packed);
  }
  const out = new Uint8Array(chunks.reduce((n, ch) => n + ch.length, 0));
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.length; }
  return out;
}
