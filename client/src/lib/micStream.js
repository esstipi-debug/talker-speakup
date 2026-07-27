/**
 * The ONLY place in the client that touches getUserMedia or Web Audio.
 *
 * useConversation must never import a Web Audio module (spec §12) — it imports
 * this, and tests mock this. A plain module singleton with no refcount and no
 * idle-grace timer: one owner, one release path. A leaked reference would
 * leave the microphone hot in the one project whose headline claim is that
 * audio stays on the machine — so every failure path below tears down whatever
 * it already acquired rather than abandoning it.
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
let releaseRequested = false;
let frames = [];
let framesEpochMs = 0;

export function isMicOpen() {
  return current !== null;
}

function closeQuietly(ctx) {
  try {
    const closing = ctx?.close?.();
    // close() returns a promise; an unhandled rejection here would surface as
    // a global error for something we do not care about.
    if (closing && typeof closing.catch === "function") closing.catch(() => {});
  } catch {
    /* already closed */
  }
}

/** Stop everything we hold, in any partial combination. Never throws. */
function teardown(stream, ctx, node) {
  try {
    node?.disconnect();
  } catch {
    /* already disconnected */
  }
  stream?.getAudioTracks?.().forEach((track) => track.stop());
  closeQuietly(ctx);
}

export async function getMicStream() {
  if (current) return;
  if (opening) return opening;

  opening = (async () => {
    let stream = null;
    let ctx = null;
    let node = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule(new URL("./prosody/pcm.worklet.js", import.meta.url));

      node = new AudioWorkletNode(ctx, "pcm-processor", {
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

      // A release asked for while we were still opening wins — publishing the
      // stream now would leave the mic hot with nobody expecting it.
      if (releaseRequested) {
        teardown(stream, ctx, node);
        return;
      }

      current = { stream, ctx, node, settings: stream.getAudioTracks()[0].getSettings() };
    } catch (err) {
      teardown(stream, ctx, node);
      throw err;
    }
  })();

  try {
    await opening;
  } finally {
    opening = null;
    releaseRequested = false;
  }
}

export function releaseMicStream() {
  // Honoured by the acquisition itself once it lands.
  if (opening) releaseRequested = true;
  if (!current) return;
  teardown(current.stream, current.ctx, current.node);
  current = null;
  frames = [];
  framesEpochMs = 0;
}

/**
 * Milliseconds since the current frame buffer began — NOT since the
 * AudioContext was created. Monotonic within a measurement window, and
 * directly comparable with the frame indices `getFrames()` returns.
 */
export function micNowMs() {
  return current ? current.ctx.currentTime * 1000 - framesEpochMs : 0;
}

/**
 * Start a new measurement window: empty the frame buffer AND re-base the clock
 * so `micNowMs()` counts from this instant. Frame indices and timestamps must
 * share an origin — they are compared directly downstream — and this module is
 * the only place that owns both, so it is the only place that can guarantee it.
 */
export function resetFrames() {
  frames = [];
  framesEpochMs = current ? current.ctx.currentTime * 1000 : 0;
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
