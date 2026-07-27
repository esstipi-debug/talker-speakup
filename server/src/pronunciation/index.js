import { MockPronunciation } from "./mock.js";
import { LocalPronunciation } from "./local.js";

/**
 * Pluggable pronunciation factory, matching brain/ tts/ stt/ — with two
 * deliberate differences (spec §4.4):
 *   1. `none` is a first-class degraded state, not an error.
 *   2. __resetForTests() clears the resolve-once cache, so the suite needs no
 *      module mocking.
 *
 * There is NO health probe and no re-probe timer. Reachability is reported by
 * the score call itself returning { scored: false, reason: 'scorer-offline' },
 * which is how starting Docker mid-session works for free: the next attempt
 * simply succeeds.
 */
let _initialized = false;
let _pron = null;
let _provider = null;

function resolveProvider() {
  const raw = process.env.PRONUNCIATION_PROVIDER?.trim().toLowerCase() || "none";
  return ["local", "mock", "none"].includes(raw) ? raw : "none";
}

export function getPron() {
  if (_initialized) return _pron;
  _provider = resolveProvider();
  _pron =
    _provider === "local"
      ? new LocalPronunciation()
      : _provider === "mock"
        ? new MockPronunciation()
        : null;
  _initialized = true;
  console.log(`[pron] provider = ${_provider}`);
  return _pron;
}

export function currentPronProvider() {
  if (!_initialized) getPron();
  return _provider;
}

export function __resetForTests() {
  _initialized = false;
  _pron = null;
  _provider = null;
}
