import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["./test/global-setup.js"],
    // Prisma's SQLite path is resolved relative to the schema directory,
    // so this lands at server/prisma/test.db.
    env: { DATABASE_URL: "file:./test.db" },
  },
});
