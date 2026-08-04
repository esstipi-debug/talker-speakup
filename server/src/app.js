import express from "express";
import cors from "cors";
import turnRouter from "./routes/turn.js";
import feedbackRouter from "./routes/feedback.js";
import { currentProvider } from "./brain/index.js";
import { currentTTSProvider } from "./tts/index.js";
import { currentSTTProvider } from "./stt/index.js";
import { currentPronProvider } from "./pronunciation/index.js";
import { harperStatus } from "./feedback/harper.js";
import { configuredFeeds } from "./seed/feeds.js";
import { stats as topicStats } from "./repo/topics.js";

/**
 * Builds the Express app but never listens — so tests can import it and bind
 * an ephemeral port. index.js owns the listener.
 */
export const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  const feedUrls = configuredFeeds();
  // Configuration and cache state, never reachability (spec §8) — no DB hit
  // at all when there's nothing configured to report on.
  const { cached, unused } = feedUrls.length > 0 ? await topicStats() : { cached: 0, unused: 0 };
  res.json({
    status: "ok",
    brain: currentProvider(),
    tts: currentTTSProvider(),
    stt: currentSTTProvider(),
    pron: currentPronProvider(),
    feedback: harperStatus(),
    sources: { provider: feedUrls.length > 0 ? "feeds" : "local", feeds: feedUrls.length, cached, unused },
    ts: Date.now(),
  });
});

app.use("/turn", turnRouter);
app.use("/feedback", feedbackRouter);

// Fallback error handler so nothing crashes the single-user server.
app.use((err, _req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});
