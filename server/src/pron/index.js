import { MockPron } from "./mock.js";
import { LocalPron } from "./local.js";
import { AzurePron } from "./azure.js";

/**
 * Pluggable pronunciation-assessment factory (design §4.1).
 *   local -> score via the sidecar container on :8899 (CAPT pipeline)
 *   mock  -> deterministic offline pseudo-scores, $0, no Docker (default)
 *   azure -> calibration reference only; never a runtime path
 * Swap with PRON_PROVIDER in server/.env.
 */
let _pron = null;
let _provider = null;

function resolveProvider() {
  const explicit = process.env.PRON_PROVIDER?.trim().toLowerCase();
  const hasAzureKey = !!process.env.AZURE_SPEECH_KEY?.trim();

  let provider = explicit || "mock";

  if (provider === "azure" && !hasAzureKey) {
    console.warn("[pron] PRON_PROVIDER=azure but AZURE_SPEECH_KEY is missing → falling back to mock.");
    provider = "mock";
  }
  if (provider !== "local" && provider !== "mock" && provider !== "azure") {
    console.warn(`[pron] unknown PRON_PROVIDER="${provider}" → falling back to mock.`);
    provider = "mock";
  }
  return provider;
}

/**
 * @returns {MockPron|LocalPron|AzurePron} never null — the drill always has a scorer to call
 */
export function getPron() {
  if (_pron) return _pron;
  _provider = resolveProvider();
  _pron =
    _provider === "local"
      ? new LocalPron()
      : _provider === "azure"
        ? new AzurePron()
        : new MockPron();
  console.log(`[pron] provider = ${_provider}`);
  return _pron;
}

/**
 * @returns {"local"|"mock"|"azure"}
 */
export function currentPronProvider() {
  if (!_provider) getPron();
  return _provider;
}
