// SHO-3019. Undo of a comment delete re-checks the 200-comment cap inside its transaction, under a
// FOR UPDATE lock on the task (src/lib/undo.ts, the `comment.removed` branch: `roomForRestore(tx, c.taskId, true)`).
// The read before the transaction can pass with room to spare and a comment can land before the locked count
// runs; that second, locked refusal had no test. With 200 live comments at the read, the earlier test
// (tests/comments-19-1.test.ts, APL-2840) only reaches the unlocked read check.
//
// This test drives the locked path itself: a separate connection takes the task row lock first, so Undo gets
// past the unlocked read and waits inside its transaction; the test then inserts the comments that take the
// task to 200 and commits. Undo's locked count sees 200 and answers 409 (not the 400 an add at the cap does).
// It calls src/lib directly, as the flag-on comment cases do: the shared server runs with ff_task_comments off.
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client";
import { addComment, removeComment } from "../src/lib/comments";
import { undoAction } from "../src/lib/undo";
import { account, project, task } from "./helpers";
import { actor } from "./concierge-helpers";

const db = new PrismaClient();
const FLAG = "FF_TASK_COMMENTS";
const tag = `${Date.now().toString(36)}-${process.pid}`;
const CAP_MESSAGE = "A task can have at most 200 comments.";

/**
 * The local test database, for the raw pg connections this test needs to hold a row lock by hand.
 * Anything but a local host is refused. Prisma's `?schema=` is Prisma-only: the pg driver would send it to the
 * server as an unknown startup setting, so it is carried over as `search_path` instead. Without that the raw
 * connections land in `public` while Prisma (and the code under test) work in the named schema, the lock guards no
 * rows, and the test proves nothing about the locked count.
 */
const testSchema = () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  return url.searchParams.get("schema") ?? "public";
};

function localDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("Refusing to run: the locked Undo test uses the local test database only");
  }
  const schema = url.searchParams.get("schema");
  url.search = "";
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString().replaceAll("+", "%20");
}

/**
 * Waits until a backend is blocked by the test's lock, which proves Undo is inside its transaction, or until
 * Undo settles first (it skipped the locked count). Returns whether it was seen waiting on the lock.
 */
async function waitForBlockedBy(watcher: pg.Client, holderPid: number, settled: () => boolean, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await watcher.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [holderPid],
    );
    if (rows[0].n > 0) return true;
    if (settled()) return false;
    if (Date.now() > deadline) throw new Error("Undo neither waited on the test's Task row lock nor finished");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("SHO-3019: Undo's locked comment restore", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
    delete process.env.FEATURE_COMMENTS;
  });
  afterEach(() => {
    delete process.env[FLAG];
    delete process.env.FEATURE_COMMENTS;
  });

  it("answers 409 when the task reaches 200 live comments before the locked count", async () => {
    const lead = await account("lead");
    const worker = await account("worker");
    const p = await project(lead, lead, [{ who: worker, role: "EDITOR" }]);
    const t = await task(worker, p.id, { dueDate: "2031-03-20", title: "ZZ-TEST SHO-3019 locked undo" });

    // The comment Undo will restore: written, then deleted by its author.
    const comment = await addComment(actor(worker), t, { text: "ZZ-TEST SHO-3019 restored" });
    await removeComment(actor(worker), t, comment.id);
    const removed = await db.actionLog.findFirstOrThrow({
      where: { targetId: t, action: "comment.removed" },
      orderBy: { createdAt: "desc" },
    });

    // 198 live comments: the read outside the transaction passes, with room for the restore.
    await db.comment.createMany({
      data: Array.from({ length: 198 }, (_, i) => ({ taskId: t, authorId: worker.id, text: `ZZ-TEST filler ${i}` })),
    });
    expect(await db.comment.count({ where: { taskId: t, removedAt: null } })).toBe(198);

    const holder = new pg.Client({ connectionString: localDatabaseUrl() });
    const watcher = new pg.Client({ connectionString: localDatabaseUrl() });
    await holder.connect();
    await watcher.connect();
    try {
      // The raw connections must see the tables the code under test writes, or the lock below is a no-op.
      const where = (await watcher.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0].schema;
      expect(where, "the raw pg connections are not in the schema DATABASE_URL names").toBe(testSchema());

      // Hold the task row exactly the way the undo transaction asks for it. Reads still go through, so Undo
      // reaches its transaction and its read check (198 live) and then waits on this lock.
      await holder.query("BEGIN");
      await holder.query('SELECT 1 FROM "Task" WHERE "id" = $1 FOR UPDATE', [t]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

      // Rejections are collected as values, so a refusal while the lock is held is not an unhandled rejection.
      let settled = false;
      // A one-slot box: reading a `let` that a callback assigns keeps TS's narrowed `null` type at the assertion.
      const refusal: { status?: number; message?: string }[] = [];
      const outcome = undoAction(actor(worker), removed.id)
        .then(
          () => null,
          (e: { status?: number; message?: string; extra?: { code?: string } }) => {
            refusal.push(e);
            return e;
          },
        )
        .finally(() => {
          settled = true;
        });
      const waitedOnLock = await waitForBlockedBy(watcher, holderPid, () => settled);
      const why = refusal[0] ? `${refusal[0].status} ${refusal[0].message}` : "it resolved";
      expect(waitedOnLock, `Undo finished without running the locked count inside its transaction (${why})`).toBe(true);

      // Two more live comments land while Undo waits on the lock: 200 by the time its locked count runs.
      await holder.query(
        'INSERT INTO "Comment" ("id", "taskId", "authorId", "text") VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)',
        [`zz-sho3019-${tag}-1`, t, worker.id, "ZZ-TEST late 1", `zz-sho3019-${tag}-2`, "ZZ-TEST late 2"],
      );
      await holder.query("COMMIT");

      const refused = await outcome;
      expect(refused, "Undo was accepted although the locked count was at the cap").toMatchObject({
        status: 409,
        message: CAP_MESSAGE,
        extra: { code: "too_many_comments" },
      });

      // Nothing was written: the comment stays deleted, the row stays undoable and no undo entry is logged.
      expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).removedAt).not.toBeNull();
      expect(await db.comment.count({ where: { taskId: t, removedAt: null } })).toBe(200);
      expect((await db.actionLog.findUniqueOrThrow({ where: { id: removed.id } })).undoneAt).toBeNull();
      expect(await db.actionLog.count({ where: { targetId: t, action: "undo" } })).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      await watcher.end();
    }

    // Leave no 200-comment task behind for the next run; the account and project rows stay, as in undo.test.ts.
    await db.comment.deleteMany({ where: { taskId: t } });
  }, 60_000);
});
