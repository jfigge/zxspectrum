// Audio output via an AudioWorklet. Tracks how many samples are queued so the
// emulation loop can run frames exactly as fast as audio is consumed.

export class AudioOutput {
  private node: AudioWorkletNode | null = null;
  private sent = 0;
  private consumed = 0;
  muted = false;

  private constructor(readonly context: AudioContext) {}

  static async create(): Promise<AudioOutput | null> {
    try {
      const context = new AudioContext({ latencyHint: 'interactive' });
      const out = new AudioOutput(context);
      await context.audioWorklet.addModule('./audio-worklet.js');
      out.node = new AudioWorkletNode(context, 'spectrum-audio', { outputChannelCount: [1] });
      out.node.port.onmessage = (e) => {
        out.consumed = e.data as number;
      };
      out.node.connect(context.destination);
      if (context.state !== 'running') await context.resume().catch(() => {});
      return out;
    } catch (err) {
      console.warn('Audio unavailable', err);
      return null;
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get running(): boolean {
    return this.context.state === 'running';
  }

  /** Samples queued but not yet played. */
  get buffered(): number {
    return this.sent - this.consumed;
  }

  push(samples: Float32Array): void {
    if (!this.node) return;
    const copy = this.muted ? new Float32Array(samples.length) : samples.slice();
    // Count before posting: transferring the buffer detaches it, zeroing its length.
    this.sent += copy.length;
    this.node.port.postMessage(copy, [copy.buffer]);
  }

  flush(): void {
    this.node?.port.postMessage('flush');
    this.sent = this.consumed;
  }

  resume(): void {
    if (this.context.state !== 'running') void this.context.resume();
  }
}
