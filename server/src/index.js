import { app } from "./app.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";
import { currentPronProvider } from "./pronunciation/index.js";
import { setupHarper } from "./feedback/harper.js";
import { activePromptLabel } from "./prompts/coach-system.js";
import { refreshFeeds } from "./seed/feeds.js";

const PORT = Number(process.env.PORT) || 3001;

// Harper's WASM must load at boot, never lazily — otherwise the learner's
// first turn pays for the WASM start.
await setupHarper();

// Unawaited and error-swallowed on purpose: the server test suite imports
// app.js (not this file) precisely so a boot-time network call never lands
// on the test process, and a session started later just reads whatever the
// cache holds by then (spec §4.4, §6).
refreshFeeds().catch((err) => console.warn("[seed/feeds] boot refresh failed:", err.message));

app.listen(PORT, () => {
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()}, pron: ${currentPronProvider()})`,
  );
  console.log(`[brain] coach prompt = ${activePromptLabel()}`);
});
