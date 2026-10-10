# ZX Spectrum

A ZX Spectrum 48K / 128K emulator for Electron, written in TypeScript.

## Getting started

```sh
npm install      # also downloads the Sinclair ROMs into resources/roms/
npm run dev      # launch with hot reload
```

Run `make help` to list the Makefile shortcuts for the scripts below. Examples are `make dev`, `make check` and `make dist`.

Other scripts:

| Script | What it does |
| --- | --- |
| `npm test` | Unit tests, plus the FUSE Z80 suite (1356 opcode tests including contention timing) |
| `npm run test:zex` | ZEXDOC and ZEXALL instruction exercisers (~3 minutes) |
| `npm run typecheck` | Run TypeScript checks |
| `npm run build` / `npm start` | Make a production build and preview it |
| `npm run dist` | Package a macOS `.dmg` with electron-builder |
| `npm run fetch-roms` | Download the ROMs again. Amstrad allows them to be redistributed for emulator use. Each one is checked against its SHA-256. |

## Using it

- **Open files** with File → Open (⌘O), drag and drop, or Open Recent. Supported formats are `.tap`, `.tzx`, `.z80` and `.sna`.
  - Snapshots switch to the right machine model automatically.
  - Tapes reset the machine and auto-load: they type `LOAD ""` on the 48K, or choose Tape Loader on the 128K.
- **Tape menu:**
  - Play/Stop (⇧⌘P), Rewind and Eject.
  - **Fast Load** catches the ROM's `LD-BYTES` routine and loads standard blocks instantly.
  - **Accelerate Loading** runs the machine at full speed while a loader is reading the tape. This covers custom and turbo loaders that Fast Load can't trap.
- **Machine menu:** switch between 48K and 128K, Reset (⌘R) and Pause (⌘P).
- **Save snapshots** as `.z80` (⌘S) or `.sna` (⇧⌘S).
- **View menu:** 1–4× scale and full screen.

### Keyboard

| PC | Spectrum |
| --- | --- |
| Letters, digits, Enter, Space | Same keys |
| Shift | CAPS SHIFT |
| Ctrl / Alt | SYMBOL SHIFT |
| Backspace | DELETE (CAPS+0) |
| Arrow keys | CAPS+5/6/7/8 |
| Esc | BREAK (CAPS+SPACE) |
| Tab | Extended mode (CAPS+SYM) |
| Typed symbols (`" + - * / = < > ; : , .` …) | The matching SYMBOL SHIFT combination |

## Layout

```
src/emu/          emulator core: pure TypeScript, no DOM or Electron, tested headlessly
  z80/z80.ts      Z80 CPU: all documented and undocumented opcodes, MEMPTR, Q, and FUSE-compatible contention
  ula.ts          video (rendered lazily per 4 T-states), contention table, floating bus
  memory.ts       48K map and 128K paging (port 0x7FFD)
  ay.ts sound.ts  AY-3-8912 chip, plus the beeper/AY/tape mixer
  tape/           TAP and TZX parsers, pulse player
  snapshot/       SNA and Z80 (v1–v3) load; SNA and Z80 v3 save
  machine.ts      ties it together; ROM loader trap; auto-load
src/main/         Electron main process: window, menus, file dialogs, settings
src/preload/      contextBridge API (sandboxed)
src/renderer/     canvas, AudioWorklet output, keyboard input, emulation loop
```

The emulation loop takes its timing from the audio clock. It runs just enough frames to keep about 60 ms of audio queued in the AudioWorklet, so the video and sound never drift apart. If audio isn't available, it falls back to wall-clock timing.
