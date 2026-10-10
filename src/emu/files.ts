// Detect and load supported file types.
import { parseSna } from './snapshot/sna';
import type { Snapshot } from './snapshot/snapshot';
import { parseZ80 } from './snapshot/z80format';
import type { Tape } from './tape/blocks';
import { parseTap } from './tape/tap';
import { parseTzx } from './tape/tzx';

export type LoadedFile = { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'tape'; tape: Tape };

export const SUPPORTED_EXTENSIONS = ['sna', 'z80', 'tap', 'tzx'];

export function loadFile(name: string, bytes: Uint8Array): LoadedFile {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'sna': return { kind: 'snapshot', snapshot: parseSna(bytes) };
    case 'z80': return { kind: 'snapshot', snapshot: parseZ80(bytes) };
    case 'tap': return { kind: 'tape', tape: parseTap(bytes, name) };
    case 'tzx': return { kind: 'tape', tape: parseTzx(bytes, name) };
    default: throw new Error(`Unsupported file type: ${name}`);
  }
}
