// ULA video generation, memory contention timing and the floating bus.
//
// The display is rendered lazily in 8-pixel cells (4 T-states each). Before
// anything that changes what the ULA would show (screen memory writes, border
// changes, screen bank switches) the machine calls update() with the current
// T-state so every cell the beam has already passed is drawn with the old
// state. This reproduces border stripes and mid-frame attribute effects.

import type { Memory } from './memory';
import type { ModelConfig } from './models';

export const BORDER_H = 48;
export const BORDER_V = 48;
export const SCREEN_WIDTH = 256 + 2 * BORDER_H;
export const SCREEN_HEIGHT = 192 + 2 * BORDER_V;
const CELLS_PER_ROW = SCREEN_WIDTH / 8;
const CELL_COUNT = CELLS_PER_ROW * SCREEN_HEIGHT;

/** Spectrum palette as little-endian ABGR for a Uint32Array over RGBA ImageData. */
const PALETTE = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const level = i & 8 ? 0xff : 0xd7;
    const r = i & 2 ? level : 0;
    const g = i & 4 ? level : 0;
    const b = i & 1 ? level : 0;
    out[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
  }
  return out;
})();

const CONTENTION_PATTERN = [6, 5, 4, 3, 2, 1, 0, 0];

export class ULA {
  readonly framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  /** Wait states by T-state, shared with the CPU. */
  readonly contention: Uint8Array;
  border = 7;
  frameCount = 0;

  private readonly cellTime = new Int32Array(CELL_COUNT);
  private nextCell = 0;
  private flashInvert = false;

  constructor(private readonly model: ModelConfig, private readonly memory: Memory) {
    const { frameLength, lineLength, paperStart } = model;

    // Contention applies during the 128 T-states of each of the 192 paper lines,
    // starting one T-state before the first pixel fetch.
    this.contention = new Uint8Array(frameLength + 0x1000);
    for (let line = 0; line < 192; line++) {
      const start = paperStart - 1 + line * lineLength;
      for (let t = 0; t < 128; t++) this.contention[start + t] = CONTENTION_PATTERN[t & 7];
    }

    for (let row = 0; row < SCREEN_HEIGHT; row++) {
      for (let col = 0; col < CELLS_PER_ROW; col++) {
        this.cellTime[row * CELLS_PER_ROW + col] =
          paperStart + (row - BORDER_V) * lineLength + (col - BORDER_H / 8) * 4;
      }
    }
  }

  reset(): void {
    this.border = 7;
    this.frameCount = 0;
    this.nextCell = 0;
  }

  /** Draw every cell the beam has reached by T-state `t`. */
  update(t: number): void {
    const cellTime = this.cellTime;
    let cell = this.nextCell;
    if (cell >= CELL_COUNT || cellTime[cell] > t) return;
    const fb = this.framebuffer;
    const screen = this.memory.ram[this.memory.screenBank];
    const borderColour = PALETTE[this.border];
    while (cell < CELL_COUNT && cellTime[cell] <= t) {
      const row = (cell / CELLS_PER_ROW) | 0;
      const col = cell - row * CELLS_PER_ROW;
      let p = row * SCREEN_WIDTH + col * 8;
      const y = row - BORDER_V;
      const x = col - BORDER_H / 8;
      if (y < 0 || y >= 192 || x < 0 || x >= 32) {
        for (let i = 0; i < 8; i++) fb[p++] = borderColour;
      } else {
        const pixels = screen[((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | x];
        const attr = screen[0x1800 + ((y >> 3) << 5) + x];
        const bright = (attr & 0x40) >> 3;
        let ink = PALETTE[(attr & 7) | bright];
        let paper = PALETTE[((attr >> 3) & 7) | bright];
        if (attr & 0x80 && this.flashInvert) {
          const t2 = ink; ink = paper; paper = t2;
        }
        for (let bit = 0x80; bit; bit >>= 1) fb[p++] = pixels & bit ? ink : paper;
      }
      cell++;
    }
    this.nextCell = cell;
  }

  setBorder(t: number, colour: number): void {
    if (colour === this.border) return;
    this.update(t);
    this.border = colour;
  }

  /** Finish the frame and prepare for the next one. */
  endFrame(): void {
    this.update(Number.MAX_SAFE_INTEGER);
    this.nextCell = 0;
    this.frameCount++;
    this.flashInvert = (this.frameCount & 16) !== 0;
  }

  /** The byte the ULA is fetching at T-state `t`, or 0xFF when idle. */
  floatingBus(t: number): number {
    const { paperStart, lineLength } = this.model;
    const rel = t - (paperStart + 2);
    if (rel < 0) return 0xff;
    const line = (rel / lineLength) | 0;
    if (line >= 192) return 0xff;
    const pos = rel - line * lineLength;
    if (pos >= 128) return 0xff;
    const phase = pos & 7;
    if (phase >= 4) return 0xff;
    const x = ((pos >> 3) << 1) | (phase >> 1);
    const screen = this.memory.ram[this.memory.screenBank];
    return phase & 1
      ? screen[0x1800 + ((line >> 3) << 5) + x]
      : screen[((line & 0xc0) << 5) | ((line & 7) << 8) | ((line & 0x38) << 2) | x];
  }
}
