// ZEXDOC / ZEXALL instruction exercisers, run under a minimal CP/M BDOS shim.
// Slow (minutes); run with `npm run test:zex`.
import { describe, expect, it } from 'vitest';
import { Z80 } from '../src/emu/z80/z80';
import { fixture } from './helpers/fixtures';

async function runCpm(name: string): Promise<string> {
  const mem = new Uint8Array(0x10000);
  mem.set(await fixture(name), 0x100);
  mem[0x0000] = 0x76; // warm boot → HALT
  mem[0x0005] = 0xc9; // BDOS entry → RET (call handled by the trap below)
  mem[0x0006] = 0x00; // top of TPA used by ZEX for its stack
  mem[0x0007] = 0xf0;
  const cpu = new Z80({
    read: (a) => mem[a],
    write: (a, v) => { mem[a] = v; },
    ioRead: () => 0xff,
    ioWrite: () => {},
  });
  cpu.pc = 0x100;
  cpu.sp = 0xf000;
  let out = '';
  for (;;) {
    if (cpu.pc === 0x0005) {
      if (cpu.c === 2) out += String.fromCharCode(cpu.e);
      else if (cpu.c === 9) for (let a = cpu.de; mem[a] !== 0x24; a = (a + 1) & 0xffff) out += String.fromCharCode(mem[a]);
    } else if (cpu.pc === 0x0000) {
      break;
    }
    cpu.step();
    if (cpu.tstates > 1e9) cpu.tstates = 0;
  }
  return out;
}

describe('instruction exercisers', () => {
  for (const name of ['zexdoc.com', 'zexall.com']) {
    it(name, async () => {
      const out = await runCpm(name);
      console.log(out);
      expect(out).not.toMatch(/ERROR/);
      expect(out).toMatch(/Tests complete/);
    }, 3_600_000);
  }
});
