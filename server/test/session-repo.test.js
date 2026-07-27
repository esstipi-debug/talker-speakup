import { describe, it, expect, afterAll } from "vitest";
import { startSession, recordTurn, getSessionWithTurns } from "../src/repo/session.js";
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
