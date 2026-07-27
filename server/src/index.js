import { app } from "./app.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()})`,
  );
});
