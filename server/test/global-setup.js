import { execSync } from "node:child_process";

/**
 * Pushes the schema into a throwaway SQLite file before the suite runs.
 * `db push` rather than `migrate deploy` — the test DB has no history to keep,
 * and this stays correct while the schema is still moving.
 */
export default function setup() {
  execSync("npm exec -- prisma db push --skip-generate --accept-data-loss", {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "inherit",
  });
}
