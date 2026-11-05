/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// App-owned audio code, never an artifact or a skill. Send only bounded mono samples in RAM.
class DictationCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frames = 0;
    this.max = Math.min(options.processorOptions.maxFrames, sampleRate * 120);
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    const count = Math.min(channels[0].length, this.max - this.frames);
    const mono = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let total = 0;
      for (const channel of channels) total += channel[i] ?? 0;
      const value = total / channels.length;
      mono[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    this.port.postMessage({ type: "samples", samples: mono }, [mono.buffer]);
    this.frames += count;
    if (this.frames >= this.max) {
      this.port.postMessage({ type: "limit" });
      return false;
    }
    return true;
  }
}
registerProcessor("fuse-dictation", DictationCapture);
