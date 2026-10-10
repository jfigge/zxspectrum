// Runs the FUSE Z80 core test suite: every opcode's final register/memory
// state, T-state count, and the sequence of memory contention probes.
import { describe, expect, it } from 'vitest';
import { Z80, type Z80Bus } from '../src/emu/z80/z80';
import { fixture } from './helpers/fixtures';

interface TestCase {
  name: string;
  regs: number[];
  state: number[];
  halted: boolean;
  tstates: number;
  mem: Array<{ addr: number; bytes: number[] }>;
}

interface Expected {
  name: string;
  events: string[];
  regs: number[];
  state: number[];
  halted: boolean;
  tstates: number;
  mem: Array<{ addr: number; bytes: number[] }>;
}

function parseInput(text: string): TestCase[] {
  const lines = text.split('\n');
  const out: TestCase[] = [];
  let i = 0;
  while (i < lines.length) {
    const name = lines[i++].trim();
    if (!name) continue;
    if (name === '-1') continue;
    const regs = lines[i++].trim().split(/\s+/).map((x) => parseInt(x, 16));
    const st = lines[i++].trim().split(/\s+/);
    const mem: TestCase['mem'] = [];
    for (;;) {
      const l = lines[i++].trim();
      if (l === '-1') break;
      const parts = l.split(/\s+/);
      const addr = parseInt(parts[0], 16);
      const bytes: number[] = [];
      for (const p of parts.slice(1)) {
        if (p === '-1') break;
        bytes.push(parseInt(p, 16));
      }
      mem.push({ addr, bytes });
    }
    out.push({
      name, regs,
      state: st.slice(0, 5).map((x, n) => (n < 2 ? parseInt(x, 16) : parseInt(x, 10))),
      halted: st[5] === '1',
      tstates: parseInt(st[6], 10),
      mem,
    });
  }
  return out;
}

function parseExpected(text: string): Map<string, Expected> {
  const blocks = text.split(/\n\s*\n/);
  const out = new Map<string, Expected>();
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (!lines.length) continue;
    const name = lines[0].trim();
    let i = 1;
    const events: string[] = [];
    while (lines[i].startsWith(' ')) events.push(lines[i++].trim().replace(/\s+/g, ' '));
    const regs = lines[i++].trim().split(/\s+/).map((x) => parseInt(x, 16));
    const st = lines[i++].trim().split(/\s+/);
    const mem: Expected['mem'] = [];
    for (; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      const bytes: number[] = [];
      for (const p of parts.slice(1)) {
        if (p === '-1') break;
        bytes.push(parseInt(p, 16));
      }
      mem.push({ addr: parseInt(parts[0], 16), bytes });
    }
    out.set(name, {
      name, events, regs,
      state: st.slice(0, 5).map((x, n) => (n < 2 ? parseInt(x, 16) : parseInt(x, 10))),
      halted: st[5] === '1',
      tstates: parseInt(st[6], 10),
      mem,
    });
  }
  return out;
}

class TracingZ80 extends Z80 {
  events: string[] = [];
  protected override contendRead(addr: number, t: number): void {
    this.events.push(`${this.tstates} MC ${addr.toString(16).padStart(4, '0')}`);
    super.contendRead(addr, t);
  }
  protected override contendNoMreq(addr: number, t: number): void {
    this.events.push(`${this.tstates} MC ${addr.toString(16).padStart(4, '0')}`);
    super.contendNoMreq(addr, t);
  }
}

function run(tc: TestCase) {
  const memory = new Uint8Array(0x10000);
  // FUSE fills memory with the pattern of its test harness: 0xde 0xad 0xbe 0xef.
  for (let a = 0; a < 0x10000; a += 4) memory.set([0xde, 0xad, 0xbe, 0xef], a);
  for (const m of tc.mem) memory.set(m.bytes, m.addr);
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  // eslint-disable-next-line prefer-const
  let cpu: TracingZ80;
  const bus: Z80Bus = {
    read: (a) => { const v = memory[a]; cpu.events.push(`${cpu.tstates} MR ${hex(a, 4)} ${hex(v, 2)}`); return v; },
    write: (a, v) => { memory[a] = v; cpu.events.push(`${cpu.tstates} MW ${hex(a, 4)} ${hex(v, 2)}`); },
    ioRead: (p) => p >> 8,
    ioWrite: () => {},
  };
  cpu = new TracingZ80(bus);
  const [af, bc, de, hl, af_, bc_, de_, hl_, ix, iy, sp, pc, memptr] = tc.regs;
  cpu.af = af; cpu.bc = bc; cpu.de = de; cpu.hl = hl;
  cpu.af_ = af_; cpu.bc_ = bc_; cpu.de_ = de_; cpu.hl_ = hl_;
  cpu.ix = ix; cpu.iy = iy; cpu.sp = sp; cpu.pc = pc; cpu.memptr = memptr;
  [cpu.i, cpu.r, cpu.iff1, cpu.iff2, cpu.im] = tc.state;
  cpu.halted = tc.halted;
  cpu.tstates = 0;
  while (cpu.tstates < tc.tstates) cpu.step();
  return { cpu, memory };
}

const input = parseInput(new TextDecoder().decode(await fixture('tests.in')));
const expected = parseExpected(new TextDecoder().decode(await fixture('tests.expected')));

describe('FUSE Z80 tests', () => {
  for (const tc of input) {
    it(tc.name, () => {
      const exp = expected.get(tc.name)!;
      const { cpu, memory } = run(tc);
      const regs = [cpu.af, cpu.bc, cpu.de, cpu.hl, cpu.af_, cpu.bc_, cpu.de_, cpu.hl_, cpu.ix, cpu.iy, cpu.sp, cpu.pc, cpu.memptr];
      const hex4 = (a: number[]) => a.map((n) => n.toString(16).padStart(4, '0')).join(' ');
      expect(hex4(regs), 'registers').toBe(hex4(exp.regs));
      expect([cpu.i, cpu.r, cpu.iff1, cpu.iff2, cpu.im], 'I R IFF1 IFF2 IM').toEqual(exp.state);
      expect(cpu.halted, 'halted').toBe(exp.halted);
      expect(cpu.tstates, 'tstates').toBe(exp.tstates);
      for (const m of exp.mem) {
        expect(Array.from(memory.slice(m.addr, m.addr + m.bytes.length)), `memory at ${m.addr.toString(16)}`).toEqual(m.bytes);
      }
      const memEvents = exp.events.filter((e) => / M[CRW] /.test(e));
      expect(cpu.events, 'memory events').toEqual(memEvents);
    });
  }
});
