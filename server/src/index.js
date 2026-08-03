import { app } from "./app.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";
import { currentPronProvider } from "./pronunciation/index.js";
import { setupHarper } from "./feedback/harper.js";

const PORT = Number(process.env.PORT) || 3001;

// Harper's WASM must load at boot, never lazily — otherwise the learner's
// first turn pays for the WASM start.
await setupHarper();

app.listen(PORT, () => {
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()}, pron: ${currentPronProvider()})`,
  );
});
