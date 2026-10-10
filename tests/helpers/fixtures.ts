// Downloads third-party test fixtures on first use (not committed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'fixtures', 'downloaded');

const SOURCES: Record<string, string> = {
  'tests.in': 'https://sourceforge.net/p/fuse-emulator/fuse/ci/master/tree/z80/tests/tests.in?format=raw',
  'tests.expected': 'https://sourceforge.net/p/fuse-emulator/fuse/ci/master/tree/z80/tests/tests.expected?format=raw',
  'zexdoc.com': 'https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexdoc.com',
  'zexall.com': 'https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexall.com',
};

export async function fixture(name: keyof typeof SOURCES | string): Promise<Uint8Array> {
  const path = join(DIR, name);
  if (!existsSync(path)) {
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`fetching ${name}: HTTP ${res.status}`);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return new Uint8Array(readFileSync(path));
}

export function rom(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, '..', '..', 'resources', 'roms', name)));
}
