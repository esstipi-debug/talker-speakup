-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ErrorLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "example" TEXT,
    "explanation" TEXT,
    "frequency" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "probesPassed" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastProbedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ErrorLedger" ("createdAt", "example", "explanation", "frequency", "id", "lastSeenAt", "pattern", "status", "type") SELECT "createdAt", "example", "explanation", "frequency", "id", "lastSeenAt", "pattern", "status", "type" FROM "ErrorLedger";
DROP TABLE "ErrorLedger";
ALTER TABLE "new_ErrorLedger" RENAME TO "ErrorLedger";
CREATE UNIQUE INDEX "ErrorLedger_pattern_key" ON "ErrorLedger"("pattern");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
