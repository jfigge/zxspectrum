// .SNA snapshots (48K: 49179 bytes; 128K: 131103 or 147487 bytes).
import { blankCpuState, snapshotPeek, snapshotPoke, type Snapshot } from './snapshot';

const HEADER = 27;
const BANK = 0x4000;

export function parseSna(bytes: Uint8Array): Snapshot {
  const is48 = bytes.length === HEADER + 3 * BANK;
  const is128 = bytes.length === HEADER + 3 * BANK + 4 + 5 * BANK || bytes.length === HEADER + 3 * BANK + 4 + 6 * BANK;
  if (!is48 && !is128) throw new Error(`Unrecognised .SNA size (${bytes.length} bytes)`);
  const w = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const cpu = blankCpuState();
  cpu.i = bytes[0];
  cpu.hl_ = w(1); cpu.de_ = w(3); cpu.bc_ = w(5); cpu.af_ = w(7);
  cpu.h = bytes[10]; cpu.l = bytes[9];
  cpu.d = bytes[12]; cpu.e = bytes[11];
  cpu.b = bytes[14]; cpu.c = bytes[13];
  cpu.iy = w(15); cpu.ix = w(17);
  cpu.iff1 = cpu.iff2 = bytes[19] & 0x04 ? 1 : 0;
  cpu.r = bytes[20];
  cpu.f = bytes[21]; cpu.a = bytes[22];
  cpu.sp = w(23);
  cpu.im = bytes[25] & 3;
  const border = bytes[26] & 7;

  const ram = new Map<number, Uint8Array>();
  const bank = (o: number) => bytes.slice(o, o + BANK);
  ram.set(5, bank(HEADER));
  ram.set(2, bank(HEADER + BANK));

  if (is48) {
    ram.set(0, bank(HEADER + 2 * BANK));
    const snap: Snapshot = { model: '48k', cpu, ram, border, port7ffd: 0 };
    // PC was pushed onto the stack when the snapshot was saved.
    cpu.pc = snapshotPeek(snap, cpu.sp) | (snapshotPeek(snap, (cpu.sp + 1) & 0xffff) << 8);
    cpu.sp = (cpu.sp + 2) & 0xffff;
    return snap;
  }

  const ext = HEADER + 3 * BANK;
  cpu.pc = w(ext);
  const port7ffd = bytes[ext + 2];
  const paged = port7ffd & 7;
  ram.set(paged, bank(HEADER + 2 * BANK));
  let o = ext + 4;
  for (let b = 0; b < 8; b++) {
    if (b === 5 || b === 2 || b === paged) continue;
    ram.set(b, bank(o));
    o += BANK;
  }
  return { model: '128k', cpu, ram, border, port7ffd };
}

export function writeSna(s: Snapshot): Uint8Array {
  const is48 = s.model === '48k';
  const paged = s.port7ffd & 7;
  const extra = is48 ? 0 : 4 + (paged === 5 || paged === 2 ? 6 : 5) * BANK;
  const out = new Uint8Array(HEADER + 3 * BANK + extra);
  const c = s.cpu;
  let sp = c.sp;
  let ram = s.ram;
  if (is48) {
    // Push PC onto a copy of memory, as the format requires.
    ram = new Map([...s.ram].map(([b, d]) => [b, d.slice()]));
    const copy = { ...s, ram };
    sp = (sp - 2) & 0xffff;
    snapshotPoke(copy, sp, c.pc & 0xff);
    snapshotPoke(copy, (sp + 1) & 0xffff, c.pc >> 8);
  }
  const w = (o: number, v: number) => { out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; };
  out[0] = c.i;
  w(1, c.hl_); w(3, c.de_); w(5, c.bc_); w(7, c.af_);
  out[9] = c.l; out[10] = c.h; out[11] = c.e; out[12] = c.d; out[13] = c.c; out[14] = c.b;
  w(15, c.iy); w(17, c.ix);
  out[19] = c.iff2 ? 0x04 : 0;
  out[20] = c.r;
  out[21] = c.f; out[22] = c.a;
  w(23, sp);
  out[25] = c.im;
  out[26] = s.border & 7;
  out.set(ram.get(5)!, HEADER);
  out.set(ram.get(2)!, HEADER + BANK);
  out.set(ram.get(is48 ? 0 : paged)!, HEADER + 2 * BANK);
  if (!is48) {
    const ext = HEADER + 3 * BANK;
    w(ext, c.pc);
    out[ext + 2] = s.port7ffd;
    out[ext + 3] = 0;
    let o = ext + 4;
    for (let b = 0; b < 8; b++) {
      if (b === 5 || b === 2 || b === paged) continue;
      out.set(ram.get(b)!, o);
      o += BANK;
    }
  }
  return out;
}
