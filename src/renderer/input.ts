// Maps PC keyboard events onto the Spectrum keyboard matrix.
//
// Letters, digits and editing keys map by physical key. Typed symbols
// (e.g. '"' or '+') map by character to Symbol Shift combinations, with the
// PC Shift key's Caps Shift suppressed so they come out as intended.

import { PC_KEY_MAP, type Keyboard, type SpectrumKey } from '../emu/keyboard';

const SYMBOLS: Record<string, SpectrumKey> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '&': '6', "'": '7', '(': '8', ')': '9', _: '0',
  '<': 'R', '>': 'T', ';': 'O', '"': 'P', '^': 'H', '-': 'J', '+': 'K', '=': 'L',
  ':': 'Z', '£': 'X', '?': 'C', '/': 'V', '*': 'B', ',': 'N', '.': 'M',
};

export class KeyboardInput {
  /** Spectrum keys contributed by each held PC key, by KeyboardEvent.code. */
  private held = new Map<string, { keys: SpectrumKey[]; symbol: boolean }>();

  constructor(private keyboard: Keyboard) {}

  setKeyboard(keyboard: Keyboard): void {
    this.keyboard = keyboard;
    this.apply();
  }

  attach(target: Window): void {
    target.addEventListener('keydown', (e) => {
      if (e.metaKey) return; // leave Cmd shortcuts to the menu
      const symbol = SYMBOLS[e.key];
      // Unshifted letter/digit keys always map physically (e.g. AZERTY digit row).
      const isAlnum = /^(Key[A-Z]|Digit\d|Numpad\d)$/.test(e.code);
      if (symbol && (e.shiftKey || !isAlnum)) {
        this.held.set(e.code, { keys: ['SYM', symbol], symbol: true });
        e.preventDefault();
        this.apply();
        return;
      }
      const physical = PC_KEY_MAP[e.code];
      if (physical) {
        this.held.set(e.code, { keys: physical, symbol: false });
        e.preventDefault();
        this.apply();
      }
    });
    target.addEventListener('keyup', (e) => {
      if (this.held.delete(e.code)) {
        e.preventDefault();
        this.apply();
      }
    });
    target.addEventListener('blur', () => this.releaseAll());
  }

  releaseAll(): void {
    this.held.clear();
    this.apply();
  }

  private apply(): void {
    const kb = this.keyboard;
    kb.releaseAll();
    const symbolHeld = [...this.held.values()].some((h) => h.symbol);
    for (const [code, { keys }] of this.held) {
      // Shift contributes CAPS SHIFT, unless it is only being used to type a symbol.
      if (symbolHeld && (code === 'ShiftLeft' || code === 'ShiftRight')) continue;
      for (const k of keys) kb.press(k);
    }
  }
}
