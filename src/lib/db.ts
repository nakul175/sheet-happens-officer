// Relative, not the "@/generated/prisma/client" alias, for the same reason as
// src/lib/shutdown.ts (SHO-2689 F7): plain `node server.js` has no tsconfig `paths`,
// so the alias made src/lib/db.ts itself unloadable and the drain could not disconnect.
import { PrismaClient } from "../generated/prisma/client.ts";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

// One client per process, in production too. `next start` bundles the instrumentation hook
// separately from the routes, so each bundle evaluates this module. Without the global they get
// different clients, and the SIGTERM drain disconnects one that never connected (APL-2689 QA D1).
globalForPrisma.prisma = db;
