import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";
import { currentPronProvider } from "./pron/index.js";

/**
 * Builds the Express app without binding a port, so route contracts can be
 * exercised by supertest (design §8). src/index.js is the only listener.
 *
 * @returns {import("express").Express}
 */
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      brain: currentProvider(),
      tts: currentTTSProvider(),
      stt: currentSTTProvider(),
      pron: currentPronProvider(),
      ts: Date.now(),
    });
  });

  app.use("/turn", turnRouter);

  // Fallback error handler so nothing crashes the single-user server.
  app.use((err, _req, res, _next) => {
    console.error("[server] unhandled error:", err);
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
