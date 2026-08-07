import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

/**
 * Pushes the schema into a throwaway SQLite file before the suite runs.
 * `db push` rather than `migrate deploy` — the test DB has no history to keep,
 * and this stays correct while the schema is still moving.
 *
 * The file is deleted first so "throwaway" is actually true: `db push` only
 * reconciles schema, it never clears rows, so without this delete the file
 * accumulates every prior run's inserts forever. That was harmless while
 * listPatterns() was unbounded, but once a row cap exists (spec D4 /
 * PATTERNS_VIEW_CAP), enough historical cruft in the same status/frequency
 * tier silently pushes a freshly-inserted test row out of the capped result.
 */
export default function setup() {
  const testDbPath = new URL("../prisma/test.db", import.meta.url);
  if (existsSync(testDbPath)) unlinkSync(testDbPath);

  execSync("npm exec -- prisma db push --skip-generate --accept-data-loss", {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "inherit",
  });
}
