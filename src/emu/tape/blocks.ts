// Common tape representation produced by the TAP and TZX parsers.

export const STANDARD = {
  pilot: 2168,
  sync1: 667,
  sync2: 735,
  zero: 855,
  one: 1710,
  headerPilotPulses: 8063,
  dataPilotPulses: 3223,
} as const;

export interface DataBlock {
  type: 'data';
  pilot: number;
  pilotPulses: number;
  sync1: number;
  sync2: number;
  zero: number;
  one: number;
  data: Uint8Array;
  /** Bits used in the last byte (1-8). */
  usedBits: number;
  /** Pause after the block in milliseconds. */
  pause: number;
}

/** A symbol in a TZX generalized data block: an edge policy plus pulse lengths. */
export interface GdbSymbol {
  /** 0 = toggle, 1 = keep level, 2 = force low, 3 = force high, applied before the first pulse. */
  flags: number;
  pulses: number[];
}

export type TapeBlock =
  | DataBlock
  | { type: 'tone'; length: number; pulses: number }
  | { type: 'pulses'; lengths: number[] }
  | { type: 'direct'; tPerSample: number; data: Uint8Array; usedBits: number; pause: number }
  | { type: 'csw'; pulses: number[]; pause: number }
  | {
      type: 'generalized';
      pause: number;
      pilotSymbols: GdbSymbol[];
      pilotStream: Array<{ symbol: number; repeat: number }>;
      dataSymbols: GdbSymbol[];
      dataStream: number[];
    }
  | { type: 'pause'; ms: number }
  | { type: 'stop48' }
  | { type: 'setLevel'; level: number }
  | { type: 'jump'; offset: number }
  | { type: 'loopStart'; count: number }
  | { type: 'loopEnd' }
  | { type: 'call'; offsets: number[] }
  | { type: 'return' }
  | { type: 'info'; text: string };

export interface Tape {
  name: string;
  blocks: TapeBlock[];
}

/** Human-readable description of a block (used in the status bar). */
export function describeBlock(block: TapeBlock): string {
  if (block.type === 'data' && block.data.length === 19 && block.data[0] === 0) {
    const kind = ['Program', 'Number array', 'Character array', 'Bytes'][block.data[1]] ?? 'Header';
    const name = String.fromCharCode(...block.data.subarray(2, 12)).trimEnd();
    return `${kind}: ${name}`;
  }
  if (block.type === 'data') return `Data (${block.data.length} bytes)`;
  if (block.type === 'info') return block.text;
  return block.type;
}
