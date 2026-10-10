// Zilog Z80 CPU core.
//
// Instruction timings, MEMPTR behaviour and the placement of contention
// probes follow the FUSE emulator, so the FUSE test suite can verify both
// results and memory-access timing. Undocumented opcodes and flags (X/Y,
// SLL, IXH/IXL, DDCB register copies, ED NOPs) are implemented.

export const FLAG_C = 0x01;
export const FLAG_N = 0x02;
export const FLAG_PV = 0x04;
export const FLAG_3 = 0x08;
export const FLAG_H = 0x10;
export const FLAG_5 = 0x20;
export const FLAG_Z = 0x40;
export const FLAG_S = 0x80;

const SZ53 = new Uint8Array(256);
const SZ53P = new Uint8Array(256);
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ53[i] = i & (FLAG_3 | FLAG_5 | FLAG_S);
  let bits = 0;
  for (let j = i; j; j >>= 1) bits += j & 1;
  PARITY[i] = bits & 1 ? 0 : FLAG_PV;
  SZ53P[i] = SZ53[i] | PARITY[i];
}
SZ53[0] |= FLAG_Z;
SZ53P[0] |= FLAG_Z;

export interface Z80Bus {
  read(addr: number): number;
  write(addr: number, value: number): void;
  ioRead(port: number): number;
  ioWrite(port: number, value: number): void;
}

export interface Z80State {
  a: number; f: number; b: number; c: number; d: number; e: number; h: number; l: number;
  af_: number; bc_: number; de_: number; hl_: number;
  ix: number; iy: number; sp: number; pc: number;
  i: number; r: number; iff1: number; iff2: number; im: number;
  halted: boolean; memptr: number; tstates: number;
}

const PREFIX_NONE = 0;
const PREFIX_DD = 0xdd;
const PREFIX_FD = 0xfd;

export class Z80 {
  a = 0xff; f = 0xff;
  b = 0; c = 0; d = 0; e = 0; h = 0; l = 0;
  af_ = 0xffff; bc_ = 0; de_ = 0; hl_ = 0;
  ix = 0; iy = 0;
  sp = 0xffff; pc = 0;
  i = 0; r = 0;
  iff1 = 0; iff2 = 0; im = 0;
  halted = false;
  memptr = 0;
  /** Flags as left by the previous instruction if it modified them, else 0 (affects SCF/CCF X/Y). */
  q = 0;
  private flagsWritten = false;

  /** T-states elapsed in the current frame. */
  tstates = 0;
  /** Set by EI; interrupts are not accepted until after the following instruction. */
  eiJustExecuted = false;

  /** Extra wait states by T-state; only consulted for addresses in contended pages. */
  contention: Uint8Array = new Uint8Array(0x20000);
  /** Non-zero for each 16K page whose accesses are contended. */
  contended = new Uint8Array(4);

  private prefix = PREFIX_NONE;

  constructor(public bus: Z80Bus) {}

  reset(): void {
    this.a = this.f = 0xff;
    this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.af_ = 0xffff; this.bc_ = this.de_ = this.hl_ = 0;
    this.ix = this.iy = 0;
    this.sp = 0xffff; this.pc = 0;
    this.i = this.r = 0;
    this.iff1 = this.iff2 = this.im = 0;
    this.halted = false;
    this.memptr = 0;
    this.q = 0;
    this.eiJustExecuted = false;
  }

  getState(): Z80State {
    const { a, f, b, c, d, e, h, l, af_, bc_, de_, hl_, ix, iy, sp, pc, i, r, iff1, iff2, im, halted, memptr, tstates } = this;
    return { a, f, b, c, d, e, h, l, af_, bc_, de_, hl_, ix, iy, sp, pc, i, r, iff1, iff2, im, halted, memptr, tstates };
  }

  setState(s: Z80State): void {
    Object.assign(this, s);
    this.eiJustExecuted = false;
  }

  // ---- 16-bit register views -------------------------------------------

  get af(): number { return (this.a << 8) | this.f; }
  set af(v: number) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  private get ir(): number { return (this.i << 8) | this.r; }

  // ---- Timing primitives -------------------------------------------------

  /** Memory cycle (or opcode fetch) of `t` T-states at `addr`, with contention. */
  protected contendRead(addr: number, t: number): void {
    if (this.contended[addr >> 14]) this.tstates += this.contention[this.tstates];
    this.tstates += t;
  }

  /** Internal cycle that leaves `addr` on the bus without MREQ; contended on the 48K/128K. */
  protected contendNoMreq(addr: number, t: number): void {
    if (this.contended[addr >> 14]) this.tstates += this.contention[this.tstates];
    this.tstates += t;
  }

  private noMreq(addr: number, count: number): void {
    for (let n = 0; n < count; n++) this.contendNoMreq(addr, 1);
  }

  /** I/O cycle timing per the ULA contention patterns (N = no delay, C = contended). */
  private portContend(port: number): void {
    const highContended = this.contended[port >> 14];
    if (port & 1) {
      if (highContended) {
        for (let n = 0; n < 4; n++) { this.tstates += this.contention[this.tstates]; this.tstates += 1; }
      } else {
        this.tstates += 4;
      }
    } else {
      if (highContended) this.tstates += this.contention[this.tstates];
      this.tstates += 1;
      this.tstates += this.contention[this.tstates];
      this.tstates += 3;
    }
  }

  private readByte(addr: number): number {
    this.contendRead(addr, 3);
    return this.bus.read(addr);
  }

  private writeByte(addr: number, v: number): void {
    this.contendRead(addr, 3);
    this.bus.write(addr, v);
  }

  private readPC(): number {
    const v = this.readByte(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private readPC16(): number {
    const lo = this.readPC();
    return lo | (this.readPC() << 8);
  }

  private fetchOpcode(): number {
    this.contendRead(this.pc, 4);
    const op = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    return op;
  }

  private portIn(port: number): number {
    this.portContend(port);
    return this.bus.ioRead(port);
  }

  private portOut(port: number, v: number): void {
    this.portContend(port);
    this.bus.ioWrite(port, v);
  }

  private push16(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.writeByte(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.writeByte(this.sp, v & 0xff);
  }

  private pop16(): number {
    const lo = this.readByte(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.readByte(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  // ---- Execution ------------------------------------------------------------

  /** Accept a maskable interrupt if enabled. Returns true if taken. */
  interrupt(): boolean {
    if (!this.iff1 || this.eiJustExecuted) return false;
    if (this.halted) {
      this.halted = false;
      this.pc = (this.pc + 1) & 0xffff;
    }
    this.iff1 = this.iff2 = 0;
    this.q = 0;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
    this.tstates += 7;
    this.push16(this.pc);
    if (this.im === 2) {
      const vector = (this.i << 8) | 0xff;
      const lo = this.readByte(vector);
      this.pc = lo | (this.readByte((vector + 1) & 0xffff) << 8);
    } else {
      this.pc = 0x38;
    }
    this.memptr = this.pc;
    return true;
  }

  /** Execute one instruction (including any prefixes). */
  step(): void {
    this.eiJustExecuted = false;
    this.flagsWritten = false;
    let op = this.fetchOpcode();
    this.prefix = PREFIX_NONE;
    while (op === PREFIX_DD || op === PREFIX_FD) {
      this.prefix = op;
      op = this.fetchOpcode();
    }
    if (op === 0xcb) {
      if (this.prefix === PREFIX_NONE) this.execCB();
      else this.execIndexedCB();
    } else if (op === 0xed) {
      this.prefix = PREFIX_NONE;
      this.execED(this.fetchOpcode());
    } else {
      this.execMain(op);
    }
    this.q = this.flagsWritten ? this.f : 0;
  }

  // ---- Register access honouring DD/FD substitution -----------------------

  private getHL(): number {
    return this.prefix === PREFIX_NONE ? this.hl : this.prefix === PREFIX_DD ? this.ix : this.iy;
  }

  private setHL(v: number): void {
    if (this.prefix === PREFIX_NONE) this.hl = v;
    else if (this.prefix === PREFIX_DD) this.ix = v;
    else this.iy = v;
  }

  /** 8-bit register by index (0-5, 7). H/L become IXH/IXL or IYH/IYL under a prefix. */
  private getR(r: number): number {
    switch (r) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.prefix === PREFIX_NONE ? this.h : this.getHL() >> 8;
      case 5: return this.prefix === PREFIX_NONE ? this.l : this.getHL() & 0xff;
      default: return this.a;
    }
  }

  private setR(r: number, v: number): void {
    switch (r) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: if (this.prefix === PREFIX_NONE) this.h = v; else this.setHL((this.getHL() & 0xff) | (v << 8)); break;
      case 5: if (this.prefix === PREFIX_NONE) this.l = v; else this.setHL((this.getHL() & 0xff00) | v); break;
      default: this.a = v; break;
    }
  }

  /** 8-bit register by index without prefix substitution. */
  private getRawR(r: number): number {
    switch (r) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      default: return this.a;
    }
  }

  private setRawR(r: number, v: number): void {
    switch (r) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      default: this.a = v; break;
    }
  }

  /** Effective address for (HL), or (IX+d)/(IY+d) including the displacement fetch. */
  private memAddr(): number {
    if (this.prefix === PREFIX_NONE) return this.hl;
    const d = this.readByte(this.pc);
    this.noMreq(this.pc, 5);
    this.pc = (this.pc + 1) & 0xffff;
    const addr = (this.getHL() + ((d << 24) >> 24)) & 0xffff;
    this.memptr = addr;
    return addr;
  }

  private getRP(p: number): number {
    switch (p) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.getHL();
      default: return this.sp;
    }
  }

  private setRP(p: number, v: number): void {
    switch (p) {
      case 0: this.bc = v; break;
      case 1: this.de = v; break;
      case 2: this.setHL(v); break;
      default: this.sp = v; break;
    }
  }

  private cond(y: number): boolean {
    switch (y) {
      case 0: return !(this.f & FLAG_Z);
      case 1: return !!(this.f & FLAG_Z);
      case 2: return !(this.f & FLAG_C);
      case 3: return !!(this.f & FLAG_C);
      case 4: return !(this.f & FLAG_PV);
      case 5: return !!(this.f & FLAG_PV);
      case 6: return !(this.f & FLAG_S);
      default: return !!(this.f & FLAG_S);
    }
  }

  // ---- ALU ------------------------------------------------------------------

  private alu(op: number, v: number): void {
    this.flagsWritten = true;
    const a = this.a;
    let r: number;
    switch (op) {
      case 0: // ADD
        r = a + v;
        this.a = r & 0xff;
        this.f = ((r >> 8) & FLAG_C) | ((a ^ v ^ r) & FLAG_H) | (((a ^ r) & (v ^ r) & 0x80) >> 5) | SZ53[this.a];
        break;
      case 1: // ADC
        r = a + v + (this.f & FLAG_C);
        this.a = r & 0xff;
        this.f = ((r >> 8) & FLAG_C) | ((a ^ v ^ r) & FLAG_H) | (((a ^ r) & (v ^ r) & 0x80) >> 5) | SZ53[this.a];
        break;
      case 2: // SUB
        r = a - v;
        this.a = r & 0xff;
        this.f = ((r >> 8) & FLAG_C) | FLAG_N | ((a ^ v ^ r) & FLAG_H) | (((a ^ v) & (a ^ r) & 0x80) >> 5) | SZ53[this.a];
        break;
      case 3: // SBC
        r = a - v - (this.f & FLAG_C);
        this.a = r & 0xff;
        this.f = ((r >> 8) & FLAG_C) | FLAG_N | ((a ^ v ^ r) & FLAG_H) | (((a ^ v) & (a ^ r) & 0x80) >> 5) | SZ53[this.a];
        break;
      case 4: // AND
        this.a = a & v;
        this.f = FLAG_H | SZ53P[this.a];
        break;
      case 5: // XOR
        this.a = a ^ v;
        this.f = SZ53P[this.a];
        break;
      case 6: // OR
        this.a = a | v;
        this.f = SZ53P[this.a];
        break;
      default: // CP: X/Y come from the operand
        r = a - v;
        this.f = ((r >> 8) & FLAG_C) | FLAG_N | ((a ^ v ^ r) & FLAG_H) | (((a ^ v) & (a ^ r) & 0x80) >> 5) |
          (r & 0xff ? 0 : FLAG_Z) | (r & FLAG_S) | (v & (FLAG_3 | FLAG_5));
        break;
    }
  }

  private inc8(v: number): number {
    this.flagsWritten = true;
    const r = (v + 1) & 0xff;
    this.f = (this.f & FLAG_C) | (r === 0x80 ? FLAG_PV : 0) | (r & 0x0f ? 0 : FLAG_H) | SZ53[r];
    return r;
  }

  private dec8(v: number): number {
    this.flagsWritten = true;
    const r = (v - 1) & 0xff;
    this.f = (this.f & FLAG_C) | (v & 0x0f ? 0 : FLAG_H) | FLAG_N | (r === 0x7f ? FLAG_PV : 0) | SZ53[r];
    return r;
  }

  private add16(a: number, v: number): number {
    this.flagsWritten = true;
    const r = a + v;
    this.memptr = (a + 1) & 0xffff;
    this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | ((r >> 16) & FLAG_C) | ((r >> 8) & (FLAG_3 | FLAG_5)) |
      (((a ^ v ^ r) >> 8) & FLAG_H);
    return r & 0xffff;
  }

  private adc16(v: number): void {
    this.flagsWritten = true;
    const hl = this.hl;
    const r = hl + v + (this.f & FLAG_C);
    this.memptr = (hl + 1) & 0xffff;
    this.hl = r & 0xffff;
    this.f = ((r >> 16) & FLAG_C) | (((hl ^ r) & (v ^ r) & 0x8000) >> 13) | ((r >> 8) & (FLAG_3 | FLAG_5 | FLAG_S)) |
      (((hl ^ v ^ r) >> 8) & FLAG_H) | (r & 0xffff ? 0 : FLAG_Z);
  }

  private sbc16(v: number): void {
    this.flagsWritten = true;
    const hl = this.hl;
    const r = hl - v - (this.f & FLAG_C);
    this.memptr = (hl + 1) & 0xffff;
    this.hl = r & 0xffff;
    this.f = ((r >> 16) & FLAG_C) | FLAG_N | (((hl ^ v) & (hl ^ r) & 0x8000) >> 13) |
      ((r >> 8) & (FLAG_3 | FLAG_5 | FLAG_S)) | (((hl ^ v ^ r) >> 8) & FLAG_H) | (r & 0xffff ? 0 : FLAG_Z);
  }

  /** CB-prefixed rotate/shift group; sets flags and returns the result. */
  private rot(op: number, v: number): number {
    this.flagsWritten = true;
    let r: number;
    let c: number;
    switch (op) {
      case 0: r = ((v << 1) | (v >> 7)) & 0xff; c = v >> 7; break; // RLC
      case 1: r = ((v >> 1) | (v << 7)) & 0xff; c = v & 1; break; // RRC
      case 2: r = ((v << 1) | (this.f & FLAG_C)) & 0xff; c = v >> 7; break; // RL
      case 3: r = (v >> 1) | ((this.f & FLAG_C) << 7); c = v & 1; break; // RR
      case 4: r = (v << 1) & 0xff; c = v >> 7; break; // SLA
      case 5: r = (v & 0x80) | (v >> 1); c = v & 1; break; // SRA
      case 6: r = ((v << 1) | 1) & 0xff; c = v >> 7; break; // SLL (undocumented)
      default: r = v >> 1; c = v & 1; break; // SRL
    }
    this.f = SZ53P[r] | c;
    return r;
  }

  /** BIT n flags; `xy` supplies the undocumented X/Y bits. */
  private bit(n: number, v: number, xy: number): void {
    this.flagsWritten = true;
    const set = v & (1 << n);
    this.f = (this.f & FLAG_C) | FLAG_H | (xy & (FLAG_3 | FLAG_5)) | (set ? 0 : FLAG_PV | FLAG_Z) | (n === 7 && set ? FLAG_S : 0);
  }

  private jr(): void {
    const d = this.readByte(this.pc);
    this.noMreq(this.pc, 5);
    this.pc = (this.pc + 1 + ((d << 24) >> 24)) & 0xffff;
    this.memptr = this.pc;
  }

  private skipJr(): void {
    this.contendRead(this.pc, 3);
    this.pc = (this.pc + 1) & 0xffff;
  }

  // ---- Unprefixed (and DD/FD-substituted) opcodes ------------------------

  private execMain(op: number): void {
    // LD r,r' and HALT
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) {
        this.halted = true;
        this.pc = (this.pc - 1) & 0xffff;
        return;
      }
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (src === 6) {
        const v = this.readByte(this.memAddr());
        this.setRawR(dst, v);
      } else if (dst === 6) {
        const addr = this.memAddr();
        this.writeByte(addr, this.getRawR(src));
      } else {
        this.setR(dst, this.getR(src));
      }
      return;
    }
    // ALU A,r
    if (op >= 0x80 && op < 0xc0) {
      const src = op & 7;
      this.alu((op >> 3) & 7, src === 6 ? this.readByte(this.memAddr()) : this.getR(src));
      return;
    }

    switch (op) {
      case 0x00: break; // NOP
      case 0x01: case 0x11: case 0x21: case 0x31: // LD rp,nn
        this.setRP(op >> 4, this.readPC16());
        break;
      case 0x02: // LD (BC),A
        this.writeByte(this.bc, this.a);
        this.memptr = ((this.bc + 1) & 0xff) | (this.a << 8);
        break;
      case 0x12: // LD (DE),A
        this.writeByte(this.de, this.a);
        this.memptr = ((this.de + 1) & 0xff) | (this.a << 8);
        break;
      case 0x03: case 0x13: case 0x23: case 0x33: // INC rp
        this.noMreq(this.ir, 2);
        this.setRP(op >> 4, (this.getRP(op >> 4) + 1) & 0xffff);
        break;
      case 0x0b: case 0x1b: case 0x2b: case 0x3b: // DEC rp
        this.noMreq(this.ir, 2);
        this.setRP(op >> 4, (this.getRP(op >> 4) - 1) & 0xffff);
        break;
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x3c: // INC r
        this.setR(op >> 3, this.inc8(this.getR(op >> 3)));
        break;
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x3d: // DEC r
        this.setR(op >> 3, this.dec8(this.getR(op >> 3)));
        break;
      case 0x34: { // INC (HL)
        const addr = this.memAddr();
        const v = this.readByte(addr);
        this.contendNoMreq(addr, 1);
        this.writeByte(addr, this.inc8(v));
        break;
      }
      case 0x35: { // DEC (HL)
        const addr = this.memAddr();
        const v = this.readByte(addr);
        this.contendNoMreq(addr, 1);
        this.writeByte(addr, this.dec8(v));
        break;
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x3e: // LD r,n
        this.setR(op >> 3, this.readPC());
        break;
      case 0x36: { // LD (HL),n
        if (this.prefix === PREFIX_NONE) {
          this.writeByte(this.hl, this.readPC());
        } else {
          const d = this.readPC();
          const n = this.readByte(this.pc);
          this.noMreq(this.pc, 2);
          this.pc = (this.pc + 1) & 0xffff;
          const addr = (this.getHL() + ((d << 24) >> 24)) & 0xffff;
          this.memptr = addr;
          this.writeByte(addr, n);
        }
        break;
      }
      case 0x07: // RLCA
        this.flagsWritten = true;
        this.a = ((this.a << 1) | (this.a >> 7)) & 0xff;
        this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | (this.a & (FLAG_C | FLAG_3 | FLAG_5));
        break;
      case 0x0f: // RRCA
        this.flagsWritten = true;
        this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | (this.a & FLAG_C);
        this.a = ((this.a >> 1) | (this.a << 7)) & 0xff;
        this.f |= this.a & (FLAG_3 | FLAG_5);
        break;
      case 0x17: { // RLA
        this.flagsWritten = true;
        const t = this.a;
        this.a = ((t << 1) | (this.f & FLAG_C)) & 0xff;
        this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | (this.a & (FLAG_3 | FLAG_5)) | (t >> 7);
        break;
      }
      case 0x1f: { // RRA
        this.flagsWritten = true;
        const t = this.a;
        this.a = (t >> 1) | ((this.f & FLAG_C) << 7);
        this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | (this.a & (FLAG_3 | FLAG_5)) | (t & FLAG_C);
        break;
      }
      case 0x08: { // EX AF,AF'
        const t = this.af;
        this.af = this.af_;
        this.af_ = t;
        break;
      }
      case 0x09: case 0x19: case 0x29: case 0x39: // ADD HL,rp
        this.noMreq(this.ir, 7);
        this.setHL(this.add16(this.getHL(), this.getRP(op >> 4)));
        break;
      case 0x0a: // LD A,(BC)
        this.memptr = (this.bc + 1) & 0xffff;
        this.a = this.readByte(this.bc);
        break;
      case 0x1a: // LD A,(DE)
        this.memptr = (this.de + 1) & 0xffff;
        this.a = this.readByte(this.de);
        break;
      case 0x10: // DJNZ
        this.contendNoMreq(this.ir, 1);
        this.b = (this.b - 1) & 0xff;
        if (this.b) this.jr(); else this.skipJr();
        break;
      case 0x18: this.jr(); break; // JR e
      case 0x20: if (!(this.f & FLAG_Z)) this.jr(); else this.skipJr(); break;
      case 0x28: if (this.f & FLAG_Z) this.jr(); else this.skipJr(); break;
      case 0x30: if (!(this.f & FLAG_C)) this.jr(); else this.skipJr(); break;
      case 0x38: if (this.f & FLAG_C) this.jr(); else this.skipJr(); break;
      case 0x22: { // LD (nn),HL
        const addr = this.readPC16();
        const v = this.getHL();
        this.writeByte(addr, v & 0xff);
        this.memptr = (addr + 1) & 0xffff;
        this.writeByte(this.memptr, v >> 8);
        break;
      }
      case 0x2a: { // LD HL,(nn)
        const addr = this.readPC16();
        const lo = this.readByte(addr);
        this.memptr = (addr + 1) & 0xffff;
        this.setHL(lo | (this.readByte(this.memptr) << 8));
        break;
      }
      case 0x27: { // DAA
        let add = 0;
        let carry = this.f & FLAG_C;
        if (this.f & FLAG_H || (this.a & 0x0f) > 9) add = 6;
        if (carry || this.a > 0x99) add |= 0x60;
        if (this.a > 0x99) carry = FLAG_C;
        this.alu(this.f & FLAG_N ? 2 : 0, add);
        this.f = (this.f & ~(FLAG_C | FLAG_PV)) | carry | PARITY[this.a];
        break;
      }
      case 0x2f: // CPL
        this.flagsWritten = true;
        this.a ^= 0xff;
        this.f = (this.f & (FLAG_C | FLAG_PV | FLAG_Z | FLAG_S)) | (this.a & (FLAG_3 | FLAG_5)) | FLAG_N | FLAG_H;
        break;
      case 0x32: { // LD (nn),A
        const addr = this.readPC16();
        this.writeByte(addr, this.a);
        this.memptr = ((addr + 1) & 0xff) | (this.a << 8);
        break;
      }
      case 0x3a: { // LD A,(nn)
        const addr = this.readPC16();
        this.memptr = (addr + 1) & 0xffff;
        this.a = this.readByte(addr);
        break;
      }
      case 0x37: // SCF
        this.flagsWritten = true;
        this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | (((this.q ^ this.f) | this.a) & (FLAG_3 | FLAG_5)) | FLAG_C;
        break;
      case 0x3f: // CCF
        this.flagsWritten = true;
        this.f = (this.f & (FLAG_PV | FLAG_Z | FLAG_S)) | (this.f & FLAG_C ? FLAG_H : FLAG_C) |
          (((this.q ^ this.f) | this.a) & (FLAG_3 | FLAG_5));
        break;

      case 0xc0: case 0xc8: case 0xd0: case 0xd8: case 0xe0: case 0xe8: case 0xf0: case 0xf8: // RET cc
        this.contendNoMreq(this.ir, 1);
        if (this.cond((op >> 3) & 7)) {
          this.pc = this.pop16();
          this.memptr = this.pc;
        }
        break;
      case 0xc9: // RET
        this.pc = this.pop16();
        this.memptr = this.pc;
        break;
      case 0xc1: this.bc = this.pop16(); break;
      case 0xd1: this.de = this.pop16(); break;
      case 0xe1: this.setHL(this.pop16()); break;
      case 0xf1: this.af = this.pop16(); break;
      case 0xc5: this.contendNoMreq(this.ir, 1); this.push16(this.bc); break;
      case 0xd5: this.contendNoMreq(this.ir, 1); this.push16(this.de); break;
      case 0xe5: this.contendNoMreq(this.ir, 1); this.push16(this.getHL()); break;
      case 0xf5: this.contendNoMreq(this.ir, 1); this.push16(this.af); break;
      case 0xc2: case 0xca: case 0xd2: case 0xda: case 0xe2: case 0xea: case 0xf2: case 0xfa: { // JP cc,nn
        const addr = this.readPC16();
        this.memptr = addr;
        if (this.cond((op >> 3) & 7)) this.pc = addr;
        break;
      }
      case 0xc3: // JP nn
        this.pc = this.memptr = this.readPC16();
        break;
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: case 0xe4: case 0xec: case 0xf4: case 0xfc: { // CALL cc,nn
        const addr = this.readPC16();
        this.memptr = addr;
        if (this.cond((op >> 3) & 7)) {
          this.contendNoMreq((this.pc - 1) & 0xffff, 1);
          this.push16(this.pc);
          this.pc = addr;
        }
        break;
      }
      case 0xcd: { // CALL nn
        const addr = this.readPC16();
        this.contendNoMreq((this.pc - 1) & 0xffff, 1);
        this.push16(this.pc);
        this.pc = this.memptr = addr;
        break;
      }
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe: // ALU n
        this.alu((op >> 3) & 7, this.readPC());
        break;
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff: // RST
        this.contendNoMreq(this.ir, 1);
        this.push16(this.pc);
        this.pc = this.memptr = op & 0x38;
        break;
      case 0xd3: { // OUT (n),A
        const n = this.readPC();
        this.portOut(n | (this.a << 8), this.a);
        this.memptr = ((n + 1) & 0xff) | (this.a << 8);
        break;
      }
      case 0xdb: { // IN A,(n)
        const port = (this.a << 8) | this.readPC();
        this.a = this.portIn(port);
        this.memptr = (port + 1) & 0xffff;
        break;
      }
      case 0xd9: { // EXX
        let t = this.bc; this.bc = this.bc_; this.bc_ = t;
        t = this.de; this.de = this.de_; this.de_ = t;
        t = this.hl; this.hl = this.hl_; this.hl_ = t;
        break;
      }
      case 0xe3: { // EX (SP),HL
        const sp = this.sp;
        const sp1 = (sp + 1) & 0xffff;
        const lo = this.readByte(sp);
        const hi = this.readByte(sp1);
        this.contendNoMreq(sp1, 1);
        const v = this.getHL();
        this.writeByte(sp1, v >> 8);
        this.writeByte(sp, v & 0xff);
        this.noMreq(sp, 2);
        this.memptr = lo | (hi << 8);
        this.setHL(this.memptr);
        break;
      }
      case 0xe9: this.pc = this.getHL(); break; // JP (HL)
      case 0xeb: { // EX DE,HL (never substituted)
        const t = this.de;
        this.de = this.hl;
        this.hl = t;
        break;
      }
      case 0xf3: this.iff1 = this.iff2 = 0; break; // DI
      case 0xfb: this.iff1 = this.iff2 = 1; this.eiJustExecuted = true; break; // EI
      case 0xf9: // LD SP,HL
        this.noMreq(this.ir, 2);
        this.sp = this.getHL();
        break;
    }
  }

  // ---- CB prefix ------------------------------------------------------------

  private execCB(): void {
    const op = this.fetchOpcode();
    const y = (op >> 3) & 7;
    const z = op & 7;
    const group = op >> 6;
    if (z === 6) {
      const addr = this.hl;
      const v = this.readByte(addr);
      this.contendNoMreq(addr, 1);
      if (group === 1) {
        this.bit(y, v, this.memptr >> 8);
        return;
      }
      this.writeByte(addr, group === 0 ? this.rot(y, v) : group === 2 ? v & ~(1 << y) : v | (1 << y));
      return;
    }
    const v = this.getRawR(z);
    switch (group) {
      case 0: this.setRawR(z, this.rot(y, v)); break;
      case 1: this.bit(y, v, v); break;
      case 2: this.setRawR(z, v & ~(1 << y)); break;
      default: this.setRawR(z, v | (1 << y)); break;
    }
  }

  /** DDCB d op / FDCB d op. */
  private execIndexedCB(): void {
    const d = this.readPC();
    const addr = (this.getHL() + ((d << 24) >> 24)) & 0xffff;
    this.memptr = addr;
    const op = this.readByte(this.pc);
    this.noMreq(this.pc, 2);
    this.pc = (this.pc + 1) & 0xffff;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const group = op >> 6;
    const v = this.readByte(addr);
    this.contendNoMreq(addr, 1);
    if (group === 1) {
      this.bit(y, v, addr >> 8);
      return;
    }
    const r = group === 0 ? this.rot(y, v) : group === 2 ? v & ~(1 << y) : v | (1 << y);
    this.writeByte(addr, r);
    if (z !== 6) this.setRawR(z, r);
  }

  // ---- ED prefix ------------------------------------------------------------

  private execED(op: number): void {
    if (op >= 0x40 && op < 0x80) {
      const y = (op >> 3) & 7;
      const p = y >> 1;
      switch (op & 7) {
        case 0: { // IN r,(C)
          this.memptr = (this.bc + 1) & 0xffff;
          const v = this.portIn(this.bc);
          this.flagsWritten = true;
          this.f = (this.f & FLAG_C) | SZ53P[v];
          if (y !== 6) this.setRawR(y, v);
          return;
        }
        case 1: // OUT (C),r
          this.portOut(this.bc, y === 6 ? 0 : this.getRawR(y));
          this.memptr = (this.bc + 1) & 0xffff;
          return;
        case 2: // SBC/ADC HL,rp
          this.noMreq(this.ir, 7);
          if (y & 1) this.adc16(this.getRP(p)); else this.sbc16(this.getRP(p));
          return;
        case 3: { // LD (nn),rp / LD rp,(nn)
          const addr = this.readPC16();
          if (y & 1) {
            const lo = this.readByte(addr);
            this.memptr = (addr + 1) & 0xffff;
            this.setRP(p, lo | (this.readByte(this.memptr) << 8));
          } else {
            const v = this.getRP(p);
            this.writeByte(addr, v & 0xff);
            this.memptr = (addr + 1) & 0xffff;
            this.writeByte(this.memptr, v >> 8);
          }
          return;
        }
        case 4: { // NEG
          const v = this.a;
          this.a = 0;
          this.alu(2, v);
          return;
        }
        case 5: // RETN / RETI
          this.iff1 = this.iff2;
          this.pc = this.pop16();
          this.memptr = this.pc;
          return;
        case 6: // IM
          this.im = [0, 0, 1, 2, 0, 0, 1, 2][y];
          return;
        default:
          switch (y) {
            case 0: this.contendNoMreq(this.ir, 1); this.i = this.a; return; // LD I,A
            case 1: this.contendNoMreq(this.ir, 1); this.r = this.a; return; // LD R,A
            case 2: // LD A,I
              this.contendNoMreq(this.ir, 1);
              this.a = this.i;
              this.flagsWritten = true;
              this.f = (this.f & FLAG_C) | SZ53[this.a] | (this.iff2 ? FLAG_PV : 0);
              return;
            case 3: // LD A,R
              this.contendNoMreq(this.ir, 1);
              this.a = this.r;
              this.flagsWritten = true;
              this.f = (this.f & FLAG_C) | SZ53[this.a] | (this.iff2 ? FLAG_PV : 0);
              return;
            case 4: { // RRD
              const hl = this.hl;
              const v = this.readByte(hl);
              this.noMreq(hl, 4);
              this.writeByte(hl, ((this.a << 4) | (v >> 4)) & 0xff);
              this.a = (this.a & 0xf0) | (v & 0x0f);
              this.flagsWritten = true;
              this.f = (this.f & FLAG_C) | SZ53P[this.a];
              this.memptr = (hl + 1) & 0xffff;
              return;
            }
            case 5: { // RLD
              const hl = this.hl;
              const v = this.readByte(hl);
              this.noMreq(hl, 4);
              this.writeByte(hl, ((v << 4) | (this.a & 0x0f)) & 0xff);
              this.a = (this.a & 0xf0) | (v >> 4);
              this.flagsWritten = true;
              this.f = (this.f & FLAG_C) | SZ53P[this.a];
              this.memptr = (hl + 1) & 0xffff;
              return;
            }
            default: return; // NOP
          }
      }
    }

    if (op >= 0xa0 && op < 0xc0 && (op & 7) < 4 && ((op >> 3) & 7) >= 4) {
      const decrement = (op & 0x08) !== 0;
      const repeat = (op & 0x10) !== 0;
      switch (op & 3) {
        case 0: this.blockLD(decrement, repeat); break;
        case 1: this.blockCP(decrement, repeat); break;
        case 2: this.blockIN(decrement, repeat); break;
        default: this.blockOUT(decrement, repeat); break;
      }
    }
    // Everything else is an 8 T-state NOP.
  }

  private blockLD(dec: boolean, repeat: boolean): void {
    this.flagsWritten = true;
    const hl = this.hl;
    const de = this.de;
    let v = this.readByte(hl);
    this.writeByte(de, v);
    this.noMreq(de, 2);
    this.bc = (this.bc - 1) & 0xffff;
    v += this.a;
    this.f = (this.f & (FLAG_C | FLAG_Z | FLAG_S)) | (this.bc ? FLAG_PV : 0) | (v & FLAG_3) | (v & 0x02 ? FLAG_5 : 0);
    if (repeat && this.bc) {
      this.noMreq(de, 5);
      this.pc = (this.pc - 2) & 0xffff;
      this.memptr = (this.pc + 1) & 0xffff;
    }
    const step = dec ? -1 : 1;
    this.hl = (hl + step) & 0xffff;
    this.de = (de + step) & 0xffff;
  }

  private blockCP(dec: boolean, repeat: boolean): void {
    this.flagsWritten = true;
    const hl = this.hl;
    const v = this.readByte(hl);
    let r = (this.a - v) & 0xff;
    this.noMreq(hl, 5);
    this.bc = (this.bc - 1) & 0xffff;
    this.f = (this.f & FLAG_C) | (this.bc ? FLAG_PV | FLAG_N : FLAG_N) | ((this.a ^ v ^ r) & FLAG_H) |
      (r ? 0 : FLAG_Z) | (r & FLAG_S);
    if (this.f & FLAG_H) r = (r - 1) & 0xff;
    this.f |= (r & FLAG_3) | (r & 0x02 ? FLAG_5 : 0);
    if (repeat && (this.f & (FLAG_PV | FLAG_Z)) === FLAG_PV) {
      this.noMreq(hl, 5);
      this.pc = (this.pc - 2) & 0xffff;
      this.memptr = (this.pc + 1) & 0xffff;
    } else {
      this.memptr = (this.memptr + (dec ? -1 : 1)) & 0xffff;
    }
    this.hl = (hl + (dec ? -1 : 1)) & 0xffff;
  }

  private blockIN(dec: boolean, repeat: boolean): void {
    this.flagsWritten = true;
    this.contendNoMreq(this.ir, 1);
    const v = this.portIn(this.bc);
    const hl = this.hl;
    this.writeByte(hl, v);
    this.memptr = (this.bc + (dec ? -1 : 1)) & 0xffff;
    this.b = (this.b - 1) & 0xff;
    const t2 = (v + this.c + (dec ? -1 : 1)) & 0xff;
    this.f = (v & 0x80 ? FLAG_N : 0) | (t2 < v ? FLAG_H | FLAG_C : 0) | (PARITY[(t2 & 7) ^ this.b] ? FLAG_PV : 0) | SZ53[this.b];
    if (repeat && this.b) {
      this.noMreq(hl, 5);
      this.pc = (this.pc - 2) & 0xffff;
    }
    this.hl = (hl + (dec ? -1 : 1)) & 0xffff;
  }

  private blockOUT(dec: boolean, repeat: boolean): void {
    this.flagsWritten = true;
    this.contendNoMreq(this.ir, 1);
    const v = this.readByte(this.hl);
    this.b = (this.b - 1) & 0xff;
    this.memptr = (this.bc + (dec ? -1 : 1)) & 0xffff;
    this.portOut(this.bc, v);
    this.hl = (this.hl + (dec ? -1 : 1)) & 0xffff;
    const t2 = (v + this.l) & 0xff;
    this.f = (v & 0x80 ? FLAG_N : 0) | (t2 < v ? FLAG_H | FLAG_C : 0) | (PARITY[(t2 & 7) ^ this.b] ? FLAG_PV : 0) | SZ53[this.b];
    if (repeat && this.b) {
      this.noMreq(this.bc, 5);
      this.pc = (this.pc - 2) & 0xffff;
    }
  }
}
