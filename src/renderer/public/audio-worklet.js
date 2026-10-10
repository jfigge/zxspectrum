// Plays PCM chunks posted from the emulator; reports consumption so the
// emulator can pace itself off the audio clock.
class SpectrumAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.consumed = 0;
    this.last = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.queue = [];
        this.offset = 0;
      } else {
        this.queue.push(e.data);
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0];
      const n = Math.min(out.length - i, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + n), i);
      i += n;
      this.offset += n;
      this.consumed += n;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (i > 0) this.last = out[i - 1];
    // Underrun: decay to silence rather than clicking.
    for (; i < out.length; i++) {
      this.last *= 0.995;
      out[i] = this.last;
    }
    this.port.postMessage(this.consumed);
    return true;
  }
}

registerProcessor('spectrum-audio', SpectrumAudio);
