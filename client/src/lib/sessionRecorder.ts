/**
 * SessionRecorder — single continuous MediaRecorder for a multi-question speaking
 * session, with pause-aware duration tracking and per-question time offsets.
 *
 * Ported from the SmallTalk2Me client design (one recording → S3 → the backend
 * slices each answer by [offset, end] ms). Improvements over the original:
 *   - performance.now() instead of Date.now() (monotonic; immune to wall-clock jumps)
 *   - explicit types, no framework coupling, no console.* (errors via onError)
 *
 * Model
 * -----
 * ONE recording covers the whole session. Between questions the recorder is
 * PAUSED, which stops the media stream AND the duration clock together, so
 * "thinking time" is excluded from both the audio and the offset math. Each
 * answer therefore occupies a contiguous [offsetMilliseconds, endMilliseconds]
 * window inside the single concatenated blob.
 *
 * Usage
 * -----
 *   const recorder = await SessionRecorder.create({ onError: reportMicError });
 *   if (!recorder) return; // unsupported or permission denied → fall back to text
 *   await recorder.prime();                       // warm up, then paused
 *   for (const problem of problems) {
 *     recorder.beginSegment(problem.id);
 *     recorder.resume();
 *     // ...user speaks; show recorder.durationMs / power meter...
 *     recorder.pause();
 *     recorder.endSegment();
 *   }
 *   const result = await recorder.stop();          // { blob, mimeType, durationMilliseconds, segments }
 *   // → upload result.blob to S3, then send result.durationMilliseconds + result.segments
 */

const TIMESLICE_MS = 1000;
const PRIME_WARMUP_MS = 500;
const FFT_SIZE = 2048;
const SILENCE_TIMEOUT_MS = 20_000;
const POWER_ACTIVE_THRESHOLD = 5;
const POWER_SCALE = 50;
const BYTE_MIDPOINT = 128;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

export type RecorderErrorReason = string;

export interface SessionRecorderOptions {
  /** Called with a short reason on any unrecoverable error (mic denied, no data, etc.). */
  onError?: (reason: RecorderErrorReason) => void;
  /** Live volume level 0..~100, on every animation frame. Optional VU meter. */
  onPower?: (level: number) => void;
  /** Toggled true after ~20s below the active threshold. Optional "are you there?" hint. */
  onSilence?: (isSilent: boolean) => void;
}

/** One answer's position inside the concatenated recording. */
export interface AudioSegment {
  problemId: string;
  offsetMilliseconds: number;
  endMilliseconds: number;
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMilliseconds: number;
  segments: readonly AudioSegment[];
}

/**
 * Pause-aware elapsed clock. Only accumulates time while active, so it stays
 * aligned with the recorded (un-paused) position in the audio stream.
 */
class DurationMeasurer {
  private accumulatedMs = 0;
  private lastResumeAt = performance.now();
  private active = true;

  pause(): void {
    if (!this.active) return;
    this.accumulatedMs += performance.now() - this.lastResumeAt;
    this.active = false;
  }

  resume(): void {
    if (this.active) return;
    this.lastResumeAt = performance.now();
    this.active = true;
  }

  get elapsedMs(): number {
    return this.active
      ? this.accumulatedMs + (performance.now() - this.lastResumeAt)
      : this.accumulatedMs;
  }
}

/**
 * Web Audio volume meter + silence detector off the live mic stream.
 * Reads peak-to-peak amplitude of the time-domain waveform each frame.
 */
class StreamPowerAnalyser {
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly bins: Uint8Array<ArrayBuffer>;
  private frame: number | null = null;
  private lastActiveAt = performance.now();

  constructor(
    stream: MediaStream,
    private readonly onPower?: (level: number) => void,
    private readonly onSilence?: (isSilent: boolean) => void,
  ) {
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    // Time-domain (waveform) reads need fftSize samples, not frequencyBinCount (fftSize/2).
    this.bins = new Uint8Array(new ArrayBuffer(FFT_SIZE));
    this.context.createMediaStreamSource(stream).connect(this.analyser);
  }

  private readonly tick = (): void => {
    const level = this.readLevel();
    this.onPower?.(level);
    if (level > POWER_ACTIVE_THRESHOLD) this.lastActiveAt = performance.now();
    this.onSilence?.(this.lastActiveAt + SILENCE_TIMEOUT_MS < performance.now());
    this.frame = requestAnimationFrame(this.tick);
  };

  private readLevel(): number {
    this.analyser.getByteTimeDomainData(this.bins);
    let min = 1;
    let max = 0;
    for (const byte of this.bins) {
      const sample = byte / BYTE_MIDPOINT;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    return (max - min) * POWER_SCALE;
  }

  resume(): void {
    if (this.frame !== null) return;
    this.lastActiveAt = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.onPower?.(0);
    this.onSilence?.(false);
  }

  dispose(): void {
    this.pause();
    void this.context.close();
  }
}

export class SessionRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private readonly duration = new DurationMeasurer();
  private readonly analyser: StreamPowerAnalyser;
  private readonly segments: AudioSegment[] = [];
  private pendingProblemId: string | null = null;
  private pendingOffsetMs: number | null = null;
  private recording = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly mimeType: string,
    private readonly options: SessionRecorderOptions,
  ) {
    this.analyser = new StreamPowerAnalyser(stream, options.onPower, options.onSilence);
    this.analyser.pause();
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined"
    );
  }

  static pickMimeType(): string | undefined {
    return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type));
  }

  /**
   * Requests the mic and builds a recorder. Resolves to null if unsupported or
   * permission is denied (onError already called) — the caller should fall back
   * to a text answer.
   */
  static async create(options: SessionRecorderOptions = {}): Promise<SessionRecorder | null> {
    if (!SessionRecorder.isSupported()) {
      options.onError?.("unsupported");
      return null;
    }

    const mimeType = SessionRecorder.pickMimeType();
    if (!mimeType) {
      options.onError?.("no-supported-mime-type");
      return null;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error: unknown) {
      options.onError?.(error instanceof Error ? error.name : "mic-error");
      return null;
    }

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      options.onError?.("no-audio-track");
      return null;
    }

    return new SessionRecorder(stream, mimeType, options);
  }

  get durationMs(): number {
    return this.duration.elapsedMs;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Warms up the encoder (start → brief record → pause) so the first real answer
   * doesn't lose its opening moment to MediaRecorder start latency.
   */
  async prime(): Promise<void> {
    this.startFresh();
    await delay(PRIME_WARMUP_MS);
    this.pause();
  }

  /** Marks the start offset of the next answer (reads the current recorded position). */
  beginSegment(problemId: string): void {
    this.pendingProblemId = problemId;
    this.pendingOffsetMs = Math.round(this.duration.elapsedMs);
  }

  /** Closes the current answer and records its [offset, end] window. */
  endSegment(): void {
    if (this.pendingOffsetMs === null || this.pendingProblemId === null) return;
    const endMilliseconds = Math.round(this.duration.elapsedMs);
    if (endMilliseconds > this.pendingOffsetMs) {
      this.segments.push({
        problemId: this.pendingProblemId,
        offsetMilliseconds: this.pendingOffsetMs,
        endMilliseconds,
      });
    }
    this.pendingOffsetMs = null;
    this.pendingProblemId = null;
  }

  resume(): void {
    if (!this.recorder || this.recorder.state !== "paused") return;
    this.recorder.resume();
    this.duration.resume();
    this.analyser.resume();
    this.recording = true;
  }

  pause(): void {
    if (!this.recorder || this.recorder.state !== "recording") return;
    this.recorder.pause();
    this.duration.pause();
    this.analyser.pause();
    this.recording = false;
  }

  /** Stops recording, flushes the final chunk, and resolves with the clip + metadata. */
  stop(): Promise<RecordingResult> {
    const recorder = this.recorder;
    if (!recorder) {
      return Promise.resolve({
        blob: new Blob([], { type: this.mimeType }),
        mimeType: this.mimeType,
        durationMilliseconds: Math.round(this.duration.elapsedMs),
        segments: this.snapshotSegments(),
      });
    }

    this.duration.pause();
    this.analyser.pause();
    this.recording = false;
    const chunks = this.chunks;
    this.recorder = null;
    this.chunks = [];

    return new Promise((resolve, reject) => {
      recorder.addEventListener(
        "stop",
        () => {
          if (chunks.length === 0) {
            this.options.onError?.("no-data");
            reject(new Error("no-data"));
            return;
          }
          resolve({
            blob: new Blob(chunks, { type: this.mimeType }),
            mimeType: this.mimeType,
            durationMilliseconds: Math.round(this.duration.elapsedMs),
            segments: this.snapshotSegments(),
          });
        },
        { once: true },
      );
      recorder.requestData();
      recorder.stop();
    });
  }

  /** Releases the mic and audio graph. Call after stop() (or to abort). */
  dispose(): void {
    this.analyser.dispose();
    this.stream.getTracks().forEach((track) => track.stop());
    this.recorder = null;
  }

  private startFresh(): void {
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this.chunks = [];
    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = () => this.options.onError?.("recorder-error");
    this.recorder.start(TIMESLICE_MS);
    this.duration.resume();
    this.analyser.resume();
    this.recording = true;
  }

  private snapshotSegments(): readonly AudioSegment[] {
    return this.segments.map((segment) => ({ ...segment }));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
