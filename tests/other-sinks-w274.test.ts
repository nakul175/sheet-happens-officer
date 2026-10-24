// SECURITY (W274). W226/W244 closed the job-error sink: a thrown message that carries a DSN, a token or a
// host path is redacted once, in runJob(), so the JobRun row, the JOB_FAILED notice and the cron's 500 are
// all clean. Nobody swept the OTHER places an internal detail can land. This file sweeps four of them and
// asks the only question that matters for each: can a reader OUTSIDE the operator group get it?
//
//   * the answer to an API caller            (src/lib/http.ts handle())
//   * the server log                         (src/lib/http.ts console.error, src/proxy.ts console.info)
//   * the bell (notification text)           (src/lib/jobs.ts tellSuperAdmins -> src/lib/feed.ts noticeText)
//   * the audit table's payload              (src/lib/auth.ts audit(), src/lib/feed.ts auditLog())
//
// The operator group here is: a SUPER_ADMIN session, the server's own stdout/stderr, the cron caller holding
// JOB_SECRET, and the outbox directory. Every value below is fake and authenticates nothing.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "./concierge-helpers";
import { account, BASE, superAdmin } from "./helpers";
import { audit } from "../src/lib/auth";
import { auditLog } from "../src/lib/feed";
import { handle } from "../src/lib/http";
import { JOBS, runJob } from "../src/lib/jobs";
import { proxy } from "../src/proxy";

// handle() opens with connection() so no API answer is prerendered at build time. Called from a test there is no
// request store, so it throws; the rest of next/server (NextRequest, NextResponse) is the real module.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const SECRET = "FAKE-w274-pony-SECRET";
const HOST = "db.w274.invalid";
/** The shape a driver, a fetch() or a config dump puts in err.message. Never a real credential. */
const MESSAGE = `connect failed for postgres://sho:${SECRET}@${HOST}:55432/sho?sslmode=require`;
const LEAKS = [SECRET, HOST];

/** Everything written to one console method while `fn` runs. */
async function capturing<T>(method: "error" | "info", fn: () => Promise<T>): Promise<{ value: T; lines: string }> {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")); };
  try {
    const value = await fn();
    return { value, lines: lines.join("\n") };
  } finally {
    console[method] = original;
  }
}

/** Every .ts/.tsx under src/, so a scan cannot miss a file by naming the wrong folder. */
function srcFiles(dir = "src"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : srcFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("W274 the answer to a caller: handle() (SECURITY)", () => {
  it("an unexpected error is a bare 500 for the caller, and the operator line carries no marker", async () => {
    const thrown = Object.assign(new Error(MESSAGE), { code: "P1001" });
    const { value: res, lines } = await capturing("error", () => handle(async () => { throw thrown; })());
    const body = await res.text();
    expect(res.status, "an unexpected error is a 500").toBe(500);
    expect(JSON.parse(body)).toEqual({ error: "Internal server error" });
    for (const leak of LEAKS) {
      expect(body, "the API answer to the caller").not.toContain(leak);
      expect(lines, "the operator console line").not.toContain(leak);
    }
    // Not swallowed either: the log names the error class and the database code, which is what triage needs.
    expect(lines).toContain("unexpected error");
    expect(lines).toContain("P1001");
  });

  it("a Prisma-style failure with no message on the error object is still a bare 500", async () => {
    const { value: res, lines } = await capturing("error", () => handle(async () => { throw { code: "P2024", meta: MESSAGE }; })());
    const body = await res.text();
    expect(res.status).toBe(500);
    for (const leak of LEAKS) {
      expect(body).not.toContain(leak);
      expect(lines).not.toContain(leak);
    }
  });

  it("no ApiError in src/ is built from a caught error's message", () => {
    // handle() returns an ApiError's message to the caller verbatim (src/lib/http.ts:70). That contract is
    // what makes an ApiError message user-facing text, so it must never be a caught error's message. A build
    // that adds `throw new ApiError(500, err.message)` turns every such error into a user-readable leak.
    const offenders = srcFiles().filter((f) => /new ApiError\([^)]*\b(err|error|e|ex|failure|caught|thrown)\.message/.test(readFileSync(f, "utf8")));
    expect(offenders, "an ApiError whose message is a caught error's message").toEqual([]);
  });
});


describe("W274 the notification text (SECURITY)", () => {
  it("a failing job tells only Super Admins, and the notice text carries no marker", async () => {
    const sa = await superAdmin();
    const member = await account("w274member");
    const workspace = await db.user.findUniqueOrThrow({ where: { id: sa.id }, select: { workspaceId: true } });
    const marker = `zz-w274-operators-${Date.now()}`;
    const active = await db.user.create({ data: { workspaceId: workspace.workspaceId, name: "ZZ-TEST active operator", email: `${marker}-active@example.invalid`, passwordHash: "not-a-login", orgRole: "SUPER_ADMIN", emailVerifiedAt: new Date() } });
    const inactive = await db.user.create({ data: { workspaceId: workspace.workspaceId, name: "ZZ-TEST inactive operator", email: `${marker}-inactive@example.invalid`, passwordHash: "not-a-login", orgRole: "SUPER_ADMIN", emailVerifiedAt: new Date(), deactivatedAt: new Date() } });
    const recipients = await db.user.findMany({ where: { orgRole: "SUPER_ADMIN", deactivatedAt: null }, select: { id: true } });
    const probe = `zz-w274-sink-${Date.now()}`;
    JOBS.push({ name: probe, about: "SECURITY probe W274: fails with a fake DSN", run: async () => { throw new Error(MESSAGE); } });
    try {
      await runJob(probe).catch(() => {});
      const rows = await db.notification.findMany({ where: { type: "JOB_FAILED", data: { path: ["job"], equals: probe } }, include: { recipient: { select: { orgRole: true, email: true } } } });
      expect(rows.length, "the notice was written").toBeGreaterThan(0);
      // Reachability: every recipient is inside the operator group.
      expect(rows.map((r) => r.recipient.orgRole)).toEqual(rows.map(() => "SUPER_ADMIN"));
      // Other suites may legitimately create another active Super Admin. The contract
      // is every active operator exactly once, not a singleton root email.
      expect(rows.map(r => r.recipientId).sort()).toEqual(recipients.map(r => r.id).sort());
      expect(rows.some(r => r.recipient.email === sa.email)).toBe(true);
      expect(rows.some(r => r.recipientId === active.id)).toBe(true);
      expect(rows.some(r => r.recipientId === inactive.id || r.recipientId === member.id)).toBe(false);
      for (const leak of LEAKS) expect(JSON.stringify(rows)).not.toContain(leak);

      const bell = (await sa.c.get("/api/notifications")).json.items as { text: string }[];
      const notice = bell.find((n) => n.text.includes(probe));
      expect(notice, "the Super Admin sees the notice").toBeTruthy();
      for (const leak of LEAKS) expect(notice?.text, "the notice text").not.toContain(leak);
      expect(notice?.text).toContain(`Scheduled job "${probe}" failed`);

      // Outside the operator group the notice does not exist at all.
      const theirBell = (await member.c.get("/api/notifications")).json.items as { text: string }[];
      expect(theirBell.filter((n) => n.text.includes(probe))).toEqual([]);
      expect((await member.c.get("/api/jobs")).status, "GET /api/jobs for a Member").toBe(404);
    } finally {
      JOBS.splice(JOBS.findIndex((j) => j.name === probe), 1);
      await db.jobRun.deleteMany({ where: { job: probe } });
      await db.notification.deleteMany({ where: { type: "JOB_FAILED", data: { path: ["job"], equals: probe } } });
      await db.user.deleteMany({ where: { id: { in: [active.id, inactive.id] } } });
    }
  });
});

describe("W274 the audit payload (SECURITY)", () => {
  it("audit data is write-only: no marker in the answer, and a Member cannot read the log at all", async () => {
    const sa = await superAdmin();
    const member = await account("w274audit");
    // The worst case: a future caller passes an error message into the audit payload.
    const actor = await db.user.findUniqueOrThrow({ where: { email: member.email } });
    await audit("W274_PROBE", { actorId: actor.id, data: { detail: MESSAGE } });
    try {
      const row = await db.auditLog.findFirstOrThrow({ where: { event: "W274_PROBE" } });
      expect(JSON.stringify(row.data), "the payload is in the table (operator/DBA only)").toContain(SECRET);

      const page = await auditLog({ id: sa.id, orgRole: "SUPER_ADMIN" }, {});
      expect(JSON.stringify(page), "GET /api/audit never returns the data payload").not.toContain(SECRET);
      for (const leak of LEAKS) expect(JSON.stringify(page), "GET /api/audit").not.toContain(leak);

      const refused = await member.c.get("/api/audit");
      expect(refused.status, "GET /api/audit for a Member").toBe(404);
      for (const leak of LEAKS) expect(JSON.stringify(refused.json), "the Member's answer").not.toContain(leak);
    } finally {
      await db.auditLog.deleteMany({ where: { event: "W274_PROBE" } });
    }
  });
});

describe("W274 the request log (SECURITY)", () => {
  it("the request log is the one sink that keeps the asked-for URL: it is stdout, and the caller gets nothing", async () => {
    const previous = process.env.RETURN_PATH_LOG;
    process.env.RETURN_PATH_LOG = "1";
    try {
      const url = `http://localhost:3393/verify?token=${SECRET}`;
      const { value: res, lines } = await capturing("info", () => proxy(new NextRequest(url)));
      // Inventory, and why the classification is what it is: the line is process stdout, written only when
      // RETURN_PATH_LOG=1 (npm run dev, the README test server, CI), and never part of a response.
      expect(lines, "the return-path line is written").toContain("/verify");
      expect(lines, "the line is the raw request URL, query included").toContain(SECRET);
      // Nothing on the wire to the caller carries it: a passthrough has no body, and the forwarded header is
      // Next's own middleware protocol (x-middleware-request-*), which the server consumes before the answer
      // leaves. Proven below against the running server, not assumed.
      expect(res.status).toBe(200);
      expect(await res.clone().text()).not.toContain(SECRET);
      const leaked = [...res.headers].filter(([k, v]) => !k.startsWith("x-middleware-") && v.includes(SECRET));
      expect(leaked, "a header on the answer that repeats the query").toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.RETURN_PATH_LOG;
      else process.env.RETURN_PATH_LOG = previous;
    }
    // Over the wire: the same URL, on the real server. No response header carries the query. The HTML does
    // repeat the caller's own path in the RSC payload (`"q":"?token=…"`), which is the URL the caller already
    // sent and already holds in its address bar — the request log remains the only sink a third party reads.
    const live = await fetch(`${BASE}/verify?token=${SECRET}`);
    const headers = [...live.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(live.status, "the live server answers the page").toBe(200);
    for (const leak of LEAKS) expect(headers, "response headers from the live server").not.toContain(leak);
    const body = await live.text();
    // Every occurrence is the caller's own query value ("?token=…"), in the path echo and the query echo.
    expect(body.split(SECRET).length - 1, "the marker appears in the body only as the caller's own query value")
      .toBe(body.split(`token=${SECRET}`).length - 1);
  });
});
