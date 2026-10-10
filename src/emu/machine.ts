// A complete ZX Spectrum 48K or 128K: CPU, memory, ULA, keyboard, sound and tape.

import { AY } from './ay';
import { Keyboard, type SpectrumKey } from './keyboard';
import { Memory } from './memory';
import { MODELS, type ModelConfig, type ModelId } from './models';
import { SoundMixer } from './sound';
import type { Tape } from './tape/blocks';
import { TapePlayer } from './tape/player';
import { ULA } from './ula';
import { FLAG_C, FLAG_Z, Z80, type Z80Bus } from './z80/z80';

export interface Roms {
  '48': Uint8Array;
  '128-0': Uint8Array;
  '128-1': Uint8Array;
}

/** LD-BYTES entry point in the 48 BASIC ROM. */
const LD_BYTES = 0x0556;

/** Port 0xFE reads per frame above which we assume a tape loader is running. */
const LOADER_READ_THRESHOLD = 400;

export class Spectrum implements Z80Bus {
  readonly model: ModelConfig;
  readonly cpu: Z80;
  readonly memory: Memory;
  readonly ula: ULA;
  readonly keyboard = new Keyboard();
  readonly ay: AY | null;
  readonly sound: SoundMixer;
  readonly tape: TapePlayer;

  /** Use the ROM trap to load standard tape blocks instantly. */
  fastLoad = true;
  /** Last value written to port 0xFE. */
  private lastFE = 0;
  private earReads = 0;
  /** True if the last frame looked like it was running a tape loader. */
  loaderActive = false;
  private scheduledKeys: Array<{ frame: number; press?: SpectrumKey[]; release?: SpectrumKey[]; play?: boolean }> = [];
  private frame = 0;

  constructor(modelId: ModelId, roms: Roms, sampleRate = 48000) {
    this.model = MODELS[modelId];
    this.memory = new Memory(
      modelId === '48k' ? [roms['48']] : [roms['128-0'], roms['128-1']],
      this.model.hasPaging,
    );
    this.cpu = new Z80(this);
    this.ula = new ULA(this.model, this.memory);
    this.cpu.contention = this.ula.contention;
    this.ay = this.model.hasAY ? new AY() : null;
    this.sound = new SoundMixer(this.model.cpuHz, sampleRate, this.model.frameLength, this.ay);
    this.tape = new TapePlayer(() => this.model.id === '48k');
    this.reset();
  }

  get framebuffer(): Uint32Array {
    return this.ula.framebuffer;
  }

  reset(): void {
    this.cpu.reset();
    this.cpu.tstates = 0;
    this.memory.reset();
    this.ula.reset();
    this.ay?.reset();
    this.keyboard.releaseAll();
    this.scheduledKeys = [];
    this.lastFE = 0;
    this.updateContendedPages();
  }

  /** Recompute which 16K pages are contended after paging changes. */
  updateContendedPages(): void {
    for (let page = 0; page < 4; page++) {
      const bank = this.memory.pageBank[page];
      // 48K: only 0x4000-0x7FFF. 128K: odd banks.
      this.cpu.contended[page] = bank >= 0 && (this.model.hasPaging ? bank & 1 : page === 1) ? 1 : 0;
    }
  }

  // ---- Z80Bus -----------------------------------------------------------------

  read(addr: number): number {
    return this.memory.pages[addr >> 14][addr & 0x3fff];
  }

  write(addr: number, v: number): void {
    const page = addr >> 14;
    if (page === 0) return; // ROM
    const offset = addr & 0x3fff;
    if (offset < 0x1b00 && this.memory.pageBank[page] === this.memory.screenBank) this.ula.update(this.cpu.tstates);
    this.memory.pages[page][offset] = v;
  }

  ioRead(port: number): number {
    const t = this.cpu.tstates;
    if (!(port & 1)) {
      this.earReads++;
      const ear = this.tape.playing ? this.tape.advance(t) : (this.lastFE >> 4) & 1;
      return this.keyboard.read(port >> 8) | 0xa0 | (ear << 6);
    }
    if (this.ay && (port & 0xc002) === 0xc000) return this.ay.readRegister();
    return this.ula.floatingBus(t);
  }

  ioWrite(port: number, v: number): void {
    const t = this.cpu.tstates;
    if (!(port & 1)) {
      this.ula.setBorder(t, v & 7);
      this.sound.setBeeper(t, v);
      this.lastFE = v;
    }
    if (this.model.hasPaging && !(port & 0x8002)) {
      const screenBefore = this.memory.screenBank;
      this.ula.update(t);
      if (this.memory.write7ffd(v)) {
        this.updateContendedPages();
        if (screenBefore !== this.memory.screenBank) this.ula.update(t);
      }
    }
    if (this.ay) {
      if ((port & 0xc002) === 0xc000) {
        this.ay.selected = v & 0x0f;
      } else if ((port & 0xc002) === 0x8000) {
        this.sound.update(t);
        this.ay.write(v);
      }
    }
  }

  // ---- Execution ----------------------------------------------------------

  /** Run one video frame. Returns the frame's audio samples. */
  runFrame(): Float32Array {
    const cpu = this.cpu;
    const { frameLength, interruptLength } = this.model;
    this.runScheduledKeys();
    this.earReads = 0;
    const tape = this.tape;

    while (cpu.tstates < frameLength) {
      if (cpu.tstates < interruptLength && cpu.iff1 && !cpu.eiJustExecuted) cpu.interrupt();
      if (cpu.pc === LD_BYTES && this.fastLoad && this.memory.basic48RomActive && tape.tape && this.trapLoadBytes()) continue;
      cpu.step();
      if (tape.playing) this.sound.setTape(cpu.tstates, tape.advance(cpu.tstates));
    }

    this.loaderActive = this.earReads > LOADER_READ_THRESHOLD;
    this.ula.endFrame();
    tape.endFrame(frameLength);
    cpu.tstates -= frameLength;
    this.frame++;
    return this.sound.endFrame(frameLength);
  }

  /**
   * Emulate LD-BYTES for the next tape data block.
   * Entry: A = expected flag byte, carry set for LOAD (clear for VERIFY), IX = address, DE = length.
   */
  private trapLoadBytes(): boolean {
    const block = this.tape.takeDataBlockForTrap();
    if (!block) return false;
    const cpu = this.cpu;
    const data = block.data;
    const isLoad = (cpu.f & FLAG_C) !== 0;
    let ok = false;
    if (data.length > 0 && data[0] === cpu.a) {
      let parity = data[0];
      let i = 1;
      let ix = cpu.ix;
      let de = cpu.de;
      let verified = true;
      while (de > 0 && i < data.length) {
        const v = data[i++];
        parity ^= v;
        if (isLoad) this.write(ix, v);
        else if (this.read(ix) !== v) verified = false;
        ix = (ix + 1) & 0xffff;
        de = (de - 1) & 0xffff;
      }
      if (de === 0 && i < data.length) {
        parity ^= data[i];
        ok = verified && parity === 0;
      }
      cpu.ix = ix;
      cpu.de = de;
      cpu.h = parity;
    }
    cpu.f = ok ? (cpu.f | FLAG_C) & ~FLAG_Z : cpu.f & ~(FLAG_C | FLAG_Z);
    // RET to LD-BYTES's caller.
    cpu.pc = this.read(cpu.sp) | (this.read((cpu.sp + 1) & 0xffff) << 8);
    cpu.sp = (cpu.sp + 2) & 0xffff;
    cpu.tstates += 100;
    return true;
  }

  // ---- Tape ---------------------------------------------------------------

  insertTape(tape: Tape): void {
    this.tape.insert(tape);
  }

  playTape(): void {
    this.tape.play(this.cpu.tstates);
  }

  stopTape(): void {
    this.tape.stop();
  }

  /** Reset, then type LOAD "" (48K) or pick Tape Loader (128K) and start the tape. */
  autoLoad(): void {
    this.reset();
    this.tape.rewind();
    this.frame = 0;
    if (this.model.id === '48k') {
      // The 48K ROM takes ~1.7 s (86 frames) to test memory before accepting keys.
      this.typeKeys(100, [['J'], ['SYM', 'P'], ['SYM', 'P'], ['ENTER']]);
    } else {
      this.typeKeys(75, [['ENTER']]);
    }
    // Start the tape as the final ENTER is pressed.
    const enter = this.scheduledKeys[this.scheduledKeys.length - 2];
    enter.play = true;
  }

  private typeKeys(startFrame: number, combos: SpectrumKey[][]): void {
    let f = this.frame + startFrame;
    for (const keys of combos) {
      this.scheduledKeys.push({ frame: f, press: keys });
      this.scheduledKeys.push({ frame: f + 4, release: keys });
      f += 8;
    }
  }

  private runScheduledKeys(): void {
    while (this.scheduledKeys.length && this.scheduledKeys[0].frame <= this.frame) {
      const ev = this.scheduledKeys.shift()!;
      ev.press?.forEach((k) => this.keyboard.press(k));
      ev.release?.forEach((k) => this.keyboard.release(k));
      if (ev.play) this.playTape();
    }
  }
}
