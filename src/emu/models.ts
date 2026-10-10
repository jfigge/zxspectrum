export type ModelId = '48k' | '128k';

export interface ModelConfig {
  id: ModelId;
  name: string;
  cpuHz: number;
  /** T-states per frame. */
  frameLength: number;
  /** T-states per scanline. */
  lineLength: number;
  /** T-state at which the ULA fetches the first byte of the top-left paper cell. */
  paperStart: number;
  /** T-states the /INT line is held active at the start of each frame. */
  interruptLength: number;
  hasAY: boolean;
  hasPaging: boolean;
}

export const MODELS: Record<ModelId, ModelConfig> = {
  '48k': {
    id: '48k', name: 'ZX Spectrum 48K',
    cpuHz: 3_500_000, frameLength: 69888, lineLength: 224, paperStart: 14336, interruptLength: 32,
    hasAY: false, hasPaging: false,
  },
  '128k': {
    id: '128k', name: 'ZX Spectrum 128K',
    cpuHz: 3_546_900, frameLength: 70908, lineLength: 228, paperStart: 14362, interruptLength: 36,
    hasAY: true, hasPaging: true,
  },
};
