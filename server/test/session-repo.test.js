import { describe, it, expect, afterAll } from "vitest";
import { startSession, recordTurn, getSessionWithTurns, saveTurnFeedback, getTurnFeedback, recordSeed } from "../src/repo/session.js";
import { getPrisma } from "../src/db.js";

afterAll(() => getPrisma().$disconnect());

describe("session repo", () => {
  it("creates a session and reads it back with no turns", async () => {
    const s = await startSession();
    expect(s.id).toBeTruthy();
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns).toEqual([]);
  });

  it("records turns in order", async () => {
    const s = await startSession();
    await recordTurn({ sessionId: s.id, role: "user", text: "hello" });
    await recordTurn({ sessionId: s.id, role: "coach", text: "hi there", xp: 5 });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns.map((t) => t.role)).toEqual(["user", "coach"]);
    expect(loaded.turns[1].xp).toBe(5);
  });

  it("round-trips the prosody payload as an object", async () => {
    const s = await startSession();
    const counts = { total: 4, internal: 3, boundary: 1, unknown: 0 };
    await recordTurn({ sessionId: s.id, role: "user", text: "hmm", prosody: counts });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].prosody).toEqual(counts);
  });

  it("stores null prosody when none was supplied", async () => {
    const s = await startSession();
    await recordTurn({ sessionId: s.id, role: "coach", text: "sure" });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].prosody).toBeNull();
  });

  it("round-trips the capture settings payload as an object", async () => {
    const s = await startSession();
    const settings = { sampleRate: 48000, echoCancellation: false, autoGainControl: false, channelCount: 1 };
    await recordTurn({ sessionId: s.id, role: "user", text: "hmm", captureSettings: settings });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].captureSettings).toEqual(settings);
  });

  it("stores null capture settings when none was supplied", async () => {
    const s = await startSession();
    await recordTurn({ sessionId: s.id, role: "coach", text: "sure" });
    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].captureSettings).toBeNull();
  });

  // Spec §6.2: the turn carries the SESSION-level fluency current at that turn
  // so the trend stays queryable for M4 without inventing a per-turn metric.
  it("writes the session fluency onto the turn when there is one", async () => {
    const s = await startSession();
    const t = await recordTurn({ sessionId: s.id, role: "user", text: "hello" });
    await saveTurnFeedback(t.id, { corrections: [], sessionFluency: 82 }, 82);

    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].fluency).toBe(82);
    expect(await getTurnFeedback(t.id)).toMatchObject({ sessionFluency: 82 });
  });

  it("leaves fluency null when there is none — 'not yet measurable' is not a score of 0", async () => {
    const s = await startSession();
    const t = await recordTurn({ sessionId: s.id, role: "user", text: "hello" });
    await saveTurnFeedback(t.id, { corrections: [], sessionFluency: null }, null);

    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].fluency).toBeNull();
  });

  it("survives one unreadable capture-settings row instead of failing the whole session read", async () => {
    const s = await startSession();
    const bad = await recordTurn({ sessionId: s.id, role: "user", text: "corrupt" });
    await getPrisma().turn.update({ where: { id: bad.id }, data: { captureSettings: "{not json" } });
    await recordTurn({ sessionId: s.id, role: "coach", text: "third" });

    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns[0].captureSettings).toBeNull(); // the bad row degrades, alone
    expect(loaded.turns[1].text).toBe("third"); // and the rows after it still arrive
  });

  it("survives one unreadable row instead of failing the whole session read", async () => {
    const s = await startSession();
    await recordTurn({ sessionId: s.id, role: "user", text: "first", prosody: { total: 1, internal: 1, boundary: 0, unknown: 0 } });
    const bad = await recordTurn({ sessionId: s.id, role: "user", text: "corrupt" });
    // Simulate corruption reaching the column by any route other than recordTurn.
    await getPrisma().turn.update({ where: { id: bad.id }, data: { prosody: "{not json" } });
    await recordTurn({ sessionId: s.id, role: "coach", text: "third" });

    const loaded = await getSessionWithTurns(s.id);
    expect(loaded.turns).toHaveLength(3);
    expect(loaded.turns[0].prosody).toEqual({ total: 1, internal: 1, boundary: 0, unknown: 0 });
    expect(loaded.turns[1].prosody).toBeNull(); // the bad row degrades, alone
    expect(loaded.turns[2].text).toBe("third"); // and the rows after it still arrive
  });
});

describe("seed provenance", () => {
  it("records which provider opened the session", async () => {
    const session = await startSession();
    await recordSeed(session.id, { provider: "local", topicId: null });

    const stored = await getSessionWithTurns(session.id);
    expect(stored.seedProvider).toBe("local");
    expect(stored.topicId).toBeNull();
  });

  it("records the topic id when the provider had one", async () => {
    const session = await startSession();
    await recordSeed(session.id, { provider: "feeds", topicId: "item-42" });

    const stored = await getSessionWithTurns(session.id);
    expect(stored.seedProvider).toBe("feeds");
    expect(stored.topicId).toBe("item-42");
  });

  it("leaves both columns null on a session that was never seeded", async () => {
    const session = await startSession();
    const stored = await getSessionWithTurns(session.id);
    expect(stored.seedProvider).toBeNull();
    expect(stored.topicId).toBeNull();
  });
});
