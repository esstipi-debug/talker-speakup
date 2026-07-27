import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.js so the tailwind plugin isn't pulled into the test transform.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    css: false,
    coverage: {
      provider: "v8",
      include: [
        "src/hooks/useConversation.js",
        "src/lib/speech.js",
        "src/lib/micStream.js",
        "src/lib/prosody/**/*.js",
      ],
      exclude: ["src/lib/prosody/*.worklet.js"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
