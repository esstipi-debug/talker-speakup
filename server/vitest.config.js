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
  },
});
