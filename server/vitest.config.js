import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["./test/global-setup.js"],
    // Prisma's SQLite path is resolved relative to the schema directory,
    // so this lands at server/prisma/test.db.
    env: { DATABASE_URL: "file:./test.db" },
    // session-repo.test.js and turn-persistence.test.js both write test.db
    // through independent PrismaClient instances; SQLite serialises writers,
    // so running test files in parallel forks risks SQLITE_BUSY. Force
    // sequential file execution instead.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      // Globs, not file lists: later tasks add modules to these directories
      // and are covered the moment they land.
      include: ["src/feedback/**/*.js", "src/metrics/**/*.js", "src/coach/**/*.js", "src/ledger/**/*.js"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
