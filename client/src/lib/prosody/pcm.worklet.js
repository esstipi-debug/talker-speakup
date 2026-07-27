/**
 * AudioWorklet: per-hop RMS in dB, plus a bounded raw PCM ring.
 *
 * DELIBERATELY IMPORT-FREE. Vite serves worklets as ESM in dev and as a
 * self-contained IIFE after build; a processor with no imports cannot diverge
 * between the two. It also keeps the audio thread to arithmetic only — no
 * nuclei detection, no counts, no rates (spec §4.1). The main thread owns all
 * interpretation.
 */

// No hopSize here: the hop IS the render quantum the browser hands process(),
// so the worklet never needs telling. Only the main thread needs the number,
// to turn a frame index back into a time.
const DEFAULTS = { batchHops: 32, ringSeconds: 15 };

class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = { ...DEFAULTS, ...(options?.processorOptions ?? {}) };
    this.batchHops = o.batchHops;
    this.batch = new Float32Array(this.batchHops);
    this.batchIndex = 0;

    this.ring = new Float32Array(Math.ceil(sampleRate * o.ringSeconds));
    this.ringWrite = 0;
    this.ringFilled = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === "dumpRing") {
        this.port.postMessage({ type: "ring", pcm: this.readRing(), sampleRate });
      }
    };
  }

  readRing() {
    if (this.ringFilled < this.ring.length) return this.ring.slice(0, this.ringWrite);
    const out = new Float32Array(this.ring.length);
    out.set(this.ring.subarray(this.ringWrite), 0);
    out.set(this.ring.subarray(0, this.ringWrite), this.ring.length - this.ringWrite);
    return out;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const s = channel[i];
      sum += s * s;
      this.ring[this.ringWrite] = s;
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
      if (this.ringFilled < this.ring.length) this.ringFilled += 1;
    }

    const rms = Math.sqrt(sum / channel.length);
    this.batch[this.batchIndex] = 20 * Math.log10(rms || 1e-9);
    this.batchIndex += 1;

    if (this.batchIndex === this.batchHops) {
      // Copy, do not transfer: transferring detaches the buffer and forces a
      // fresh allocation inside process() ~12x/s, which is the GC pressure
      // we are avoiding in the first place.
      this.port.postMessage({ type: "frames", rmsDb: this.batch.slice(0) });
      this.batchIndex = 0;
    }
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
