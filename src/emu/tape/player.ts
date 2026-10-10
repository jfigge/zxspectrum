// Turns tape blocks into a stream of EAR edges timed in CPU T-states.

import { describeBlock, type DataBlock, type Tape, type TapeBlock } from './blocks';

/** What to do to the EAR level at the start of a pulse. */
const enum Edge { Toggle, Keep, Low, High }

type Pulse = [duration: number, edge: Edge];

const MS = 3500; // T-states per millisecond

function* dataBits(data: Uint8Array, usedBits: number): Generator<number> {
  for (let i = 0; i < data.length; i++) {
    const bits = i === data.length - 1 ? usedBits : 8;
    for (let b = 0; b < bits; b++) yield (data[i] >> (7 - b)) & 1;
  }
}

function* pausePulses(ms: number): Generator<Pulse> {
  if (ms <= 0) return;
  // The level drops low 1 ms into the pause.
  yield [MS, Edge.Keep];
  if (ms > 1) yield [(ms - 1) * MS, Edge.Low];
}

function* symbolPulses(sym: { flags: number; pulses: number[] }): Generator<Pulse> {
  const first: Edge = [Edge.Toggle, Edge.Keep, Edge.Low, Edge.High][sym.flags];
  for (let i = 0; i < sym.pulses.length; i++) yield [sym.pulses[i], i === 0 ? first : Edge.Toggle];
}

function* blockPulses(block: TapeBlock): Generator<Pulse> {
  switch (block.type) {
    case 'data':
      for (let i = 0; i < block.pilotPulses; i++) yield [block.pilot, Edge.Toggle];
      if (block.sync1) yield [block.sync1, Edge.Toggle];
      if (block.sync2) yield [block.sync2, Edge.Toggle];
      for (const bit of dataBits(block.data, block.usedBits)) {
        const len = bit ? block.one : block.zero;
        yield [len, Edge.Toggle];
        yield [len, Edge.Toggle];
      }
      // The final edge of the data is followed by the pause.
      if (block.pause) {
        yield [MS, Edge.Toggle];
        if (block.pause > 1) yield [(block.pause - 1) * MS, Edge.Low];
      }
      return;
    case 'tone':
      for (let i = 0; i < block.pulses; i++) yield [block.length, Edge.Toggle];
      return;
    case 'pulses':
    case 'csw':
      for (const len of block.type === 'pulses' ? block.lengths : block.pulses) yield [len, Edge.Toggle];
      if (block.type === 'csw') yield* pausePulses(block.pause);
      return;
    case 'direct': {
      // Each bit is the level for one sample period; merge runs into pulses.
      let level = -1;
      let run = 0;
      for (const bit of dataBits(block.data, block.usedBits)) {
        if (bit === level) {
          run += block.tPerSample;
        } else {
          if (run) yield [run, level ? Edge.High : Edge.Low];
          level = bit;
          run = block.tPerSample;
        }
      }
      if (run) yield [run, level ? Edge.High : Edge.Low];
      yield* pausePulses(block.pause);
      return;
    }
    case 'generalized':
      for (const { symbol, repeat } of block.pilotStream) {
        for (let i = 0; i < repeat; i++) yield* symbolPulses(block.pilotSymbols[symbol]);
      }
      for (const symbol of block.dataStream) yield* symbolPulses(block.dataSymbols[symbol]);
      yield* pausePulses(block.pause);
      return;
    case 'pause':
      yield* pausePulses(block.ms);
      return;
    default:
      return;
  }
}

export interface TapeStatus {
  name: string;
  playing: boolean;
  block: number;
  blockCount: number;
  description: string;
}

export class TapePlayer {
  tape: Tape | null = null;
  playing = false;
  /** Current EAR input level (0/1). */
  level = 0;
  /** Absolute T-state of the next edge, in the current frame's time base. */
  private nextEdgeT = 0;
  private index = 0;
  private pulses: Generator<Pulse> | null = null;
  private loopStack: Array<{ start: number; remaining: number }> = [];
  private callStack: Array<{ offsets: number[]; next: number; callIndex: number }> = [];

  constructor(private readonly is48k: () => boolean) {}

  insert(tape: Tape): void {
    this.tape = tape;
    this.rewind();
  }

  eject(): void {
    this.tape = null;
    this.playing = false;
  }

  rewind(): void {
    this.index = 0;
    this.pulses = null;
    this.loopStack = [];
    this.callStack = [];
    this.level = 0;
  }

  play(t: number): void {
    if (!this.tape || this.playing) return;
    if (this.index >= this.tape.blocks.length) this.rewind();
    this.playing = true;
    this.nextEdgeT = t;
  }

  stop(): void {
    this.playing = false;
  }

  get atEnd(): boolean {
    return !this.tape || this.index >= this.tape.blocks.length;
  }

  status(): TapeStatus | null {
    if (!this.tape) return null;
    const blockCount = this.tape.blocks.length;
    const block = Math.min(this.index, blockCount - 1);
    return {
      name: this.tape.name,
      playing: this.playing,
      block: Math.min(this.index + 1, blockCount),
      blockCount,
      description: block >= 0 ? describeBlock(this.tape.blocks[block]) : '',
    };
  }

  /** Advance to T-state `t`, returning the EAR level. */
  advance(t: number): number {
    while (this.playing && this.nextEdgeT <= t) this.nextPulse();
    return this.level;
  }

  /** Shift the time base at the end of a frame. */
  endFrame(frameLength: number): void {
    if (this.playing) this.nextEdgeT -= frameLength;
  }

  private nextPulse(): void {
    for (;;) {
      if (!this.pulses) {
        if (!this.startBlock()) {
          this.playing = false;
          return;
        }
        continue;
      }
      const r = this.pulses.next();
      if (r.done) {
        this.pulses = null;
        this.index++;
        continue;
      }
      const [duration, edge] = r.value;
      if (edge === Edge.Toggle) this.level ^= 1;
      else if (edge === Edge.Low) this.level = 0;
      else if (edge === Edge.High) this.level = 1;
      this.nextEdgeT += duration;
      return;
    }
  }

  /** Process control blocks and start the next block that produces pulses. Returns false to stop. */
  private startBlock(): boolean {
    const blocks = this.tape?.blocks;
    while (blocks && this.index < blocks.length) {
      const block = blocks[this.index];
      switch (block.type) {
        case 'pause':
          if (block.ms === 0) {
            this.index++;
            return false; // "Stop the tape"
          }
          this.pulses = blockPulses(block);
          return true;
        case 'stop48':
          this.index++;
          if (this.is48k()) return false;
          continue;
        case 'setLevel':
          this.level = block.level;
          this.index++;
          continue;
        case 'jump':
          this.index += block.offset;
          continue;
        case 'loopStart':
          this.loopStack.push({ start: this.index + 1, remaining: block.count });
          this.index++;
          continue;
        case 'loopEnd': {
          const loop = this.loopStack[this.loopStack.length - 1];
          if (loop && --loop.remaining > 0) {
            this.index = loop.start;
          } else {
            this.loopStack.pop();
            this.index++;
          }
          continue;
        }
        case 'call':
          if (!block.offsets.length) { this.index++; continue; }
          this.callStack.push({ offsets: block.offsets, next: 1, callIndex: this.index });
          this.index += block.offsets[0];
          continue;
        case 'return': {
          const frame = this.callStack[this.callStack.length - 1];
          if (!frame) { this.index++; continue; }
          if (frame.next < frame.offsets.length) {
            this.index = frame.callIndex + frame.offsets[frame.next++];
          } else {
            this.callStack.pop();
            this.index = frame.callIndex + 1;
          }
          continue;
        }
        case 'info':
          this.index++;
          continue;
        default:
          this.pulses = blockPulses(block);
          return true;
      }
    }
    return false;
  }

  /**
   * For the ROM loader trap: the next data block, consuming any non-data
   * blocks before it. Returns null if a block that needs real-time playback
   * (custom timing or control flow) comes first.
   */
  takeDataBlockForTrap(): DataBlock | null {
    const blocks = this.tape?.blocks;
    if (!blocks) return null;
    let start = this.index;
    if (this.pulses) {
      // Mid-block: a data block being played is taken whole; anything else is skipped.
      const current = blocks[this.index];
      this.pulses = null;
      if (current?.type === 'data') {
        this.index++;
        return current;
      }
      start++;
    }
    for (let i = start; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'data') {
        this.index = i + 1;
        this.pulses = null;
        this.level = 0;
        return block;
      }
      if (block.type !== 'info' && block.type !== 'pause') return null;
    }
    return null;
  }
}
