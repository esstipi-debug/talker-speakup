import { PrismaClient } from "@prisma/client";

/** Lazy singleton — the client is expensive and the server is single-user. */
let _prisma = null;

export function getPrisma() {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}
