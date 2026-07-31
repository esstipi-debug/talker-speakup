import { MockPron } from "./mock.js";
import { LocalPron } from "./local.js";
import { AzurePron } from "./azure.js";
import { BudgetGuard } from "./budgetGuard.js";
import { BudgetCappedPron } from "./budgetCappedPron.js";

/**
 * Pluggable pronunciation-assessment factory (design §4.1, amended §13).
 *   local -> score via the sidecar container on :8899 (CAPT pipeline)
 *   mock  -> deterministic offline pseudo-scores, $0, no Docker (default)
 *   azure -> a manually-selected, budget-capped supplement (design §13) —
 *            still requires an explicit PRON_PROVIDER=azure + a key; wrapped
 *            in BudgetCappedPron, which falls back to mock once the monthly
 *            spend cap (PRON_AZURE_MONTHLY_CAP_USD) is met. Never the default,
 *            never selected by key presence alone.
 * Swap with PRON_PROVIDER in server/.env.
 */
let _pron = null;
let _provider = null;

const DEFAULT_AZURE_CAP_USD = 12;
const DEFAULT_AZURE_RATE_PER_HOUR_USD = 0.66;
const DEFAULT_BUDGET_STATE_FILE = ".pron-budget.json";

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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

function buildAzurePron() {
  const guard = new BudgetGuard({
    statePath: process.env.PRON_BUDGET_STATE_FILE?.trim() || DEFAULT_BUDGET_STATE_FILE,
    capUsd: numberEnv("PRON_AZURE_MONTHLY_CAP_USD", DEFAULT_AZURE_CAP_USD),
    ratePerHourUsd: numberEnv("PRON_AZURE_RATE_PER_HOUR_USD", DEFAULT_AZURE_RATE_PER_HOUR_USD),
  });
  return new BudgetCappedPron(new AzurePron(), new MockPron(), guard);
}

/**
 * @returns {MockPron|LocalPron|BudgetCappedPron} never null — the drill always has a scorer to call
 */
export function getPron() {
  if (_pron) return _pron;
  _provider = resolveProvider();
  _pron =
    _provider === "local"
      ? new LocalPron()
      : _provider === "azure"
        ? buildAzurePron()
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
