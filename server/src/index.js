import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    brain: currentProvider(),
    tts: currentTTSProvider(),
    stt: currentSTTProvider(),
    ts: Date.now(),
  });
});

app.use("/turn", turnRouter);

// Fallback error handler so nothing crashes the single-user server.
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(
    `[server] SpeakUp API → http://localhost:${PORT}  (brain: ${currentProvider()}, voice: ${currentTTSProvider()}, stt: ${currentSTTProvider()})`,
  );
});
