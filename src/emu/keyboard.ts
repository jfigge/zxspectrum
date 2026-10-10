// The Spectrum keyboard: 8 half-rows of 5 keys, selected by A8-A15 when reading port 0xFE.

export type SpectrumKey =
  | 'CAPS' | 'Z' | 'X' | 'C' | 'V'
  | 'A' | 'S' | 'D' | 'F' | 'G'
  | 'Q' | 'W' | 'E' | 'R' | 'T'
  | '1' | '2' | '3' | '4' | '5'
  | '0' | '9' | '8' | '7' | '6'
  | 'P' | 'O' | 'I' | 'U' | 'Y'
  | 'ENTER' | 'L' | 'K' | 'J' | 'H'
  | 'SPACE' | 'SYM' | 'M' | 'N' | 'B';

const ROWS: SpectrumKey[][] = [
  ['CAPS', 'Z', 'X', 'C', 'V'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'],
  ['P', 'O', 'I', 'U', 'Y'],
  ['ENTER', 'L', 'K', 'J', 'H'],
  ['SPACE', 'SYM', 'M', 'N', 'B'],
];

const POSITION = new Map<SpectrumKey, [row: number, bit: number]>();
ROWS.forEach((row, r) => row.forEach((key, b) => POSITION.set(key, [r, b])));

export class Keyboard {
  /** Active-low key state per half-row (bits 0-4). */
  readonly rows = new Uint8Array(8).fill(0x1f);
  private readonly pressCount = new Map<SpectrumKey, number>();

  /** Press a key. Presses are reference-counted so two PC keys can share a Spectrum key. */
  press(key: SpectrumKey): void {
    const n = (this.pressCount.get(key) ?? 0) + 1;
    this.pressCount.set(key, n);
    const [r, b] = POSITION.get(key)!;
    this.rows[r] &= ~(1 << b);
  }

  release(key: SpectrumKey): void {
    const n = (this.pressCount.get(key) ?? 0) - 1;
    if (n > 0) {
      this.pressCount.set(key, n);
      return;
    }
    this.pressCount.delete(key);
    const [r, b] = POSITION.get(key)!;
    this.rows[r] |= 1 << b;
  }

  releaseAll(): void {
    this.pressCount.clear();
    this.rows.fill(0x1f);
  }

  /** Bits 0-4 of a port 0xFE read for the given port high byte. */
  read(high: number): number {
    let v = 0x1f;
    for (let r = 0; r < 8; r++) if (!(high & (1 << r))) v &= this.rows[r];
    return v;
  }
}

/** Map a DOM KeyboardEvent.code to one or more Spectrum keys. */
export const PC_KEY_MAP: Record<string, SpectrumKey[]> = {
  ShiftLeft: ['CAPS'], ShiftRight: ['CAPS'],
  ControlLeft: ['SYM'], ControlRight: ['SYM'], AltLeft: ['SYM'], AltRight: ['SYM'],
  Enter: ['ENTER'], NumpadEnter: ['ENTER'], Space: ['SPACE'],
  Backspace: ['CAPS', '0'],
  ArrowLeft: ['CAPS', '5'], ArrowDown: ['CAPS', '6'], ArrowUp: ['CAPS', '7'], ArrowRight: ['CAPS', '8'],
  CapsLock: ['CAPS', '2'], Escape: ['CAPS', 'SPACE'], Tab: ['CAPS', 'SYM'],
  Comma: ['SYM', 'N'], Period: ['SYM', 'M'], Slash: ['SYM', 'V'], Semicolon: ['SYM', 'O'],
  Quote: ['SYM', 'P'], Minus: ['SYM', 'J'], Equal: ['SYM', 'L'],
};
for (const k of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') PC_KEY_MAP[`Key${k}`] = [k as SpectrumKey];
for (const k of '0123456789') {
  PC_KEY_MAP[`Digit${k}`] = [k as SpectrumKey];
  PC_KEY_MAP[`Numpad${k}`] = [k as SpectrumKey];
}
