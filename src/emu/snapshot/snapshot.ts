import type { Spectrum } from '../machine';
import type { ModelId } from '../models';
import type { Z80State } from '../z80/z80';

/** Model-independent machine state used by the snapshot formats. */
export interface Snapshot {
  model: ModelId;
  cpu: Z80State;
  /** RAM banks by number; a 48K uses banks 5, 2 and 0 at 0x4000, 0x8000, 0xC000. */
  ram: Map<number, Uint8Array>;
  border: number;
  port7ffd: number;
  ay?: { selected: number; regs: Uint8Array };
}

export function applySnapshot(m: Spectrum, s: Snapshot): void {
  if (m.model.id !== s.model) throw new Error(`Snapshot needs a ${s.model} machine`);
  m.reset();
  for (const [bank, data] of s.ram) m.memory.ram[bank].set(data);
  if (m.model.hasPaging) m.memory.applyPaging(s.port7ffd);
  m.updateContendedPages();
  m.cpu.setState({ ...s.cpu, tstates: m.model.interruptLength });
  m.ula.border = s.border & 7;
  if (m.ay && s.ay) {
    for (let r = 0; r < 16; r++) m.ay.writeRegister(r, s.ay.regs[r]);
    m.ay.selected = s.ay.selected & 0x0f;
  }
}

export function captureSnapshot(m: Spectrum): Snapshot {
  const ram = new Map<number, Uint8Array>();
  const banks = m.model.hasPaging ? [0, 1, 2, 3, 4, 5, 6, 7] : [5, 2, 0];
  for (const b of banks) ram.set(b, m.memory.ram[b].slice());
  return {
    model: m.model.id,
    cpu: m.cpu.getState(),
    ram,
    border: m.ula.border,
    port7ffd: m.memory.last7ffd,
    ay: m.ay ? { selected: m.ay.selected, regs: m.ay.regs.slice() } : undefined,
  };
}

/** Read a byte from snapshot RAM using the 48K/128K memory map. */
export function snapshotPeek(s: Snapshot, addr: number): number {
  const page = addr >> 14;
  const bank = [-1, 5, 2, s.model === '48k' ? 0 : s.port7ffd & 7][page];
  return bank < 0 ? 0 : s.ram.get(bank)![addr & 0x3fff];
}

export function snapshotPoke(s: Snapshot, addr: number, v: number): void {
  const page = addr >> 14;
  const bank = [-1, 5, 2, s.model === '48k' ? 0 : s.port7ffd & 7][page];
  if (bank >= 0) s.ram.get(bank)![addr & 0x3fff] = v;
}

export function blankCpuState(): Z80State {
  return {
    a: 0, f: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0, af_: 0, bc_: 0, de_: 0, hl_: 0,
    ix: 0, iy: 0, sp: 0, pc: 0, i: 0, r: 0, iff1: 0, iff2: 0, im: 0, halted: false, memptr: 0, tstates: 0,
  };
}
