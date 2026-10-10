// 48K/128K memory map. The 48K uses the same bank layout as the 128K
// with paging fixed: ROM, bank 5, bank 2, bank 0.

export const PAGE_SIZE = 0x4000;

export class Memory {
  readonly rom: Uint8Array[];
  readonly ram: Uint8Array[] = Array.from({ length: 8 }, () => new Uint8Array(PAGE_SIZE));
  /** Currently mapped 16K pages for 0x0000, 0x4000, 0x8000, 0xC000. */
  readonly pages: Uint8Array[];
  /** RAM bank number mapped in each page (-1 for ROM). */
  readonly pageBank = new Int8Array([-1, 5, 2, 0]);
  romIndex = 0;
  /** RAM bank the ULA displays (5 normally, 7 when selected on the 128K). */
  screenBank = 5;
  last7ffd = 0;
  pagingLocked = false;

  constructor(roms: Uint8Array[], readonly hasPaging: boolean) {
    this.rom = roms.map((r) => {
      if (r.length !== PAGE_SIZE) throw new Error(`ROM image must be 16384 bytes (got ${r.length})`);
      return r;
    });
    this.pages = [this.rom[0], this.ram[5], this.ram[2], this.ram[0]];
  }

  reset(): void {
    for (const bank of this.ram) bank.fill(0);
    this.pagingLocked = false;
    this.applyPaging(0);
  }

  /** Port 0x7FFD write. Returns false if paging is locked. */
  write7ffd(v: number): boolean {
    if (!this.hasPaging || this.pagingLocked) return false;
    this.applyPaging(v);
    return true;
  }

  applyPaging(v: number): void {
    this.last7ffd = v & 0xff;
    if (!this.hasPaging) return;
    const bank = v & 7;
    this.romIndex = (v >> 4) & 1;
    this.screenBank = v & 0x08 ? 7 : 5;
    this.pagingLocked = (v & 0x20) !== 0;
    this.pages[0] = this.rom[this.romIndex];
    this.pages[3] = this.ram[bank];
    this.pageBank[3] = bank;
  }

  /** Whether the 48 BASIC ROM (containing LD-BYTES at 0x0556) is paged in. */
  get basic48RomActive(): boolean {
    return !this.hasPaging || this.romIndex === 1;
  }

  read(addr: number): number {
    return this.pages[addr >> 14][addr & 0x3fff];
  }
}
