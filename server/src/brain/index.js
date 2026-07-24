import { MockBrain } from "./mock.js";
import { MistralBrain } from "./mistral.js";

/**
 * Pluggable brain factory (handoff §6).
 * Swap models by env — zero lock-in. Implementations share the
 * `evaluateTurn(ctx) -> Promise<{ coach_reply, xp, ... }>` contract.
 */
let _brain = null;
let _provider = null;

function resolveProvider() {
  const explicit = process.env.BRAIN_PROVIDER?.trim().toLowerCase();
  const hasMistralKey = !!process.env.MISTRAL_API_KEY?.trim();

  let provider = explicit || (hasMistralKey ? "mistral" : "mock");

  if (provider === "mistral" && !hasMistralKey) {
    console.warn("[brain] BRAIN_PROVIDER=mistral but MISTRAL_API_KEY is missing → falling back to mock.");
    provider = "mock";
  }
  return provider;
}

export function getBrain() {
  if (_brain) return _brain;
  _provider = resolveProvider();
  _brain = _provider === "mistral" ? new MistralBrain() : new MockBrain();
  console.log(`[brain] provider = ${_provider}`);
  return _brain;
}

export function currentProvider() {
  if (!_provider) getBrain();
  return _provider;
}
