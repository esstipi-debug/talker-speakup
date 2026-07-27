/**
 * The ONLY place in the client that touches getUserMedia or Web Audio.
 *
 * useConversation must never import a Web Audio module (spec §12) — it imports
 * this, and tests mock this. A plain module singleton with no refcount and no
 * idle-grace timer: one owner, one release path. A leaked reference would
 * leave the microphone hot in the one project whose headline claim is that
 * audio stays on the machine.
 */

const HOP_SIZE = 128;
const BATCH_HOPS = 32;
const RING_SECONDS = 15;

/** Everything the browser is allowed to do to the signal, switched off. */
const CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
};

let current = null;
let opening = null;
let frames = [];

export function isMicOpen() {
  return current !== null;
}

export async function getMicStream() {
  if (current) return;
  if (opening) return opening;

  opening = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    const track = stream.getAudioTracks()[0];
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL("./prosody/pcm.worklet.js", import.meta.url));

    const node = new AudioWorkletNode(ctx, "pcm-processor", {
      // HOP_SIZE is deliberately not passed: the worklet's hop is whatever
      // quantum the browser hands it. This module keeps the number only to
      // convert a frame index back into milliseconds.
      processorOptions: { batchHops: BATCH_HOPS, ringSeconds: RING_SECONDS },
    });
    node.port.onmessage = (e) => {
      if (e.data?.type === "frames") {
        for (let i = 0; i < e.data.rmsDb.length; i += 1) frames.push(e.data.rmsDb[i]);
      }
    };
    ctx.createMediaStreamSource(stream).connect(node);

    current = { stream, track, ctx, node, settings: track.getSettings() };
  })();

  try {
    await opening;
  } finally {
    opening = null;
  }
}

export function releaseMicStream() {
  if (!current) return;
  try { current.node.disconnect(); } catch { /* already torn down */ }
  current.track.stop();
  current.ctx.close?.();
  current = null;
  frames = [];
}

/** Worklet-clock milliseconds. Monotonic, and aligned with the frame indices. */
export function micNowMs() {
  return current ? current.ctx.currentTime * 1000 : 0;
}

export function resetFrames() {
  frames = [];
}

export function getFrames() {
  return Float32Array.from(frames);
}

export function getHopMs() {
  const rate = current?.ctx.sampleRate ?? 48000;
  return (HOP_SIZE / rate) * 1000;
}

export function getCaptureSettings() {
  return current?.settings ?? null;
}
