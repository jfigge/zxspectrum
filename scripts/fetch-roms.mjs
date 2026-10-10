// Downloads the Sinclair/Amstrad ROM images into resources/roms/.
// Amstrad permits redistribution of these ROMs for use with emulators.
// Images come from the FUSE emulator source tree and are verified by SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'roms');
const SOURCE = (name) => `https://sourceforge.net/p/fuse-emulator/fuse/ci/master/tree/roms/${name}?format=raw`;

const ROMS = [
  { name: '48.rom', sha256: 'd55daa439b673b0e3f5897f99ac37ecb45f974d1862b4dadb85dec34af99cb42' },
  { name: '128-0.rom', sha256: '3ba308f23b9471d13d9ba30c23030059a9ce5d4b317b85b86274b132651d1425' },
  { name: '128-1.rom', sha256: '8d93c3342321e9d1e51d60afcd7d15f6a7afd978c231b43435a7c0757c60b9a3' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(ROM_DIR, { recursive: true });
let failed = false;
for (const rom of ROMS) {
  const path = join(ROM_DIR, rom.name);
  if (existsSync(path) && sha256(readFileSync(path)) === rom.sha256) {
    console.log(`[roms] ${rom.name} ok`);
    continue;
  }
  try {
    const res = await fetch(SOURCE(rom.name));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== 16384) throw new Error(`unexpected size ${buf.length}`);
    if (sha256(buf) !== rom.sha256) throw new Error('checksum mismatch');
    writeFileSync(path, buf);
    console.log(`[roms] ${rom.name} downloaded`);
  } catch (err) {
    failed = true;
    console.warn(`[roms] could not fetch ${rom.name}: ${err.message}`);
  }
}
if (failed) {
  console.warn(`[roms] Some ROMs are missing. Place 48.rom, 128-0.rom and 128-1.rom in ${ROM_DIR} manually.`);
}
