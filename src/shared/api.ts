// Types shared by the main, preload and renderer processes.

export type ModelId = '48k' | '128k';
export type SnapshotFormat = 'z80' | 'sna';

export interface Settings {
  model: ModelId;
  fastLoad: boolean;
  accelerateLoading: boolean;
  scale: number;
  recent: string[];
}

export interface OpenedFile {
  name: string;
  data: Uint8Array;
}

export type Roms = Record<'48' | '128-0' | '128-1', Uint8Array>;

/** Commands sent from the application menu to the renderer. */
export type Command =
  | { type: 'open-file'; file: OpenedFile }
  | { type: 'set-model'; model: ModelId }
  | { type: 'reset' }
  | { type: 'toggle-pause' }
  | { type: 'save-snapshot'; format: SnapshotFormat }
  | { type: 'tape-toggle' }
  | { type: 'tape-rewind' }
  | { type: 'tape-eject' }
  | { type: 'set-fast-load'; enabled: boolean }
  | { type: 'set-accelerate'; enabled: boolean };

export interface ZxApi {
  getRoms(): Promise<Roms>;
  getSettings(): Promise<Settings>;
  setModel(model: ModelId): Promise<void>;
  openFileDialog(): Promise<OpenedFile | null>;
  saveFile(defaultName: string, data: Uint8Array): Promise<boolean>;
  addRecent(path: string): Promise<void>;
  pathForFile(file: File): string;
  onCommand(cb: (cmd: Command) => void): void;
}
