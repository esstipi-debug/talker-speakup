import { defineConfig } from "vitest/config";

// Server-side Vitest — same runner and idiom as the client (design §8), node
// environment, no jsdom. `node --env-file` does not apply here, so tests set
// process.env explicitly.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    coverage: {
      provider: "v8",
      include: [
        "src/pron/index.js",
        "src/pron/contract.js",
        "src/pron/mock.js",
        "src/pron/local.js",
        "src/pron/prompts.js",
        "src/routes/pron.js",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
