// SHO-2897: the property behind the APL-2609 outbox gate — two specs must not be able to consume each other's mail.
//
// The gate in tests/e2e/stories/APL-2609.spec.ts:59-71 only asks whether EMAIL_OUTBOX_DIR is set and readable. That is
// necessary but not sufficient: if the folder a reader resolves is a SHARED default (".outbox" against the reader's own
// cwd) rather than the one folder the server was told to write, then a spec that sends nothing is satisfied by a mail
// another spec's server wrote, and its "the outbox is configured, so run" gate opens on a folder this spec does not own.
//
// Proven here with the real writer (src/lib/email.ts sendMail) and the real reader expression, in a scratch directory.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { outboxDir } from "./e2e/outbox";

const scratch = mkdtempSync(path.join(tmpdir(), "sho-2897-collision-"));
const saved = { dir: process.env.EMAIL_OUTBOX_DIR, cwd: process.cwd() };

/** Exactly the selection every reader in this repo makes: exact recipient, /Verify/ subject, newest file wins. */
function readVerifyToken(dir: string, email: string): string | null {
  let files: string[] = [];
  try { files = readdirSync(dir).sort(); } catch { return null; }
  const mails = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { to?: string; subject?: string; text?: string })
    .filter((m) => m.to === email && /Verify/.test(m.subject ?? ""));
  return mails.at(-1)?.text?.match(/token=([\w-]+)/)?.[1] ?? null;
}

/** The pre-fix expression, quoted from tests/helpers.ts:6, tests/e2e/stories/qa.ts:13, APL-2660.spec.ts:14,
 *  APL-2669.spec.ts:14, tests/e2e/local-api.ts:9 and APL-2506.spec.ts:28. Kept as the hazard measurement. */
const legacyReaderDir = () => process.env.EMAIL_OUTBOX_DIR ?? path.join(process.cwd(), ".outbox");

/** One real send, through the production writer. `dir` undefined means the writer's own default, which is the hazard. */
async function serverWrites(to: string, token: string, dir?: string) {
  if (dir === undefined) delete process.env.EMAIL_OUTBOX_DIR;
  else process.env.EMAIL_OUTBOX_DIR = dir;
  const { sendMail } = await import("../src/lib/email");
  await sendMail({ to, subject: "Verify your email for Sheet Happens Officer", text: `https://local/verify?token=${token}` });
}

beforeEach(() => {
  delete process.env.EMAIL_OUTBOX_DIR;
  process.chdir(scratch);
});

afterAll(() => {
  process.chdir(saved.cwd);
  if (saved.dir === undefined) delete process.env.EMAIL_OUTBOX_DIR;
  else process.env.EMAIL_OUTBOX_DIR = saved.dir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("SHO-2897: two specs sharing one outbox directory", () => {
  it("MEASUREMENT: with the shared default, spec B's assertion is satisfied by spec A's mail", async () => {
    // Spec A's server writes a Verify mail for the one address several specs reuse (root.test@aplyd.com), with no
    // EMAIL_OUTBOX_DIR, so src/lib/email.ts:63 writes ".outbox" against the server's cwd.
    const shared = path.join(scratch, "shared");
    mkdirSync(shared, { recursive: true });
    process.chdir(shared);
    await serverWrites("root.test@aplyd.com", "SPEC-A-TOKEN");
    expect(readdirSync(path.join(shared, ".outbox")).length, "spec A wrote into the shared .outbox").toBe(1);

    // Spec B never sent anything, and resolves the folder the way the repo's readers do.
    expect(readVerifyToken(legacyReaderDir(), "root.test@aplyd.com")).toBe("SPEC-A-TOKEN");
  }, 30_000);

  it("with EMAIL_OUTBOX_DIR unset, a reader fails loudly naming the variable instead of reading a shared .outbox", () => {
    expect(() => outboxDir("tests/e2e/stories/APL-2660.spec.ts")).toThrow(/EMAIL_OUTBOX_DIR is not set/);
    // And it must not silently resolve to the cwd default the old constant used.
    expect(() => outboxDir("tests/e2e/stories/APL-2660.spec.ts")).toThrow(/APL-2660/);
  });

  it("the shared vitest helper hands no spec a shared .outbox folder", async () => {
    delete process.env.EMAIL_OUTBOX_DIR;
    // OUTBOX is what tests/people.test.ts:12, tests/auth.test.ts:32 and four more files read directly.
    const helpers = await import("./helpers");
    expect(helpers.OUTBOX, "tests/helpers.ts must not default to a shared .outbox").not.toBe(".outbox");
    expect(helpers.OUTBOX, "tests/helpers.ts must not guess a folder of its own").not.toContain(".outbox");
  });

  it("two runs given their own folders cannot see each other's mail", async () => {
    const a = path.join(scratch, "run-a");
    const b = path.join(scratch, "run-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    await serverWrites("nakul17+zz-2669-x@aplyd.com", "RUN-A-TOKEN", a);

    process.env.EMAIL_OUTBOX_DIR = a;
    expect(readVerifyToken(outboxDir("APL-2669"), "nakul17+zz-2669-x@aplyd.com")).toBe("RUN-A-TOKEN");

    process.env.EMAIL_OUTBOX_DIR = b;
    expect(readVerifyToken(outboxDir("APL-2669"), "nakul17+zz-2669-x@aplyd.com")).toBeNull();
    expect(a).not.toBe(b);
  }, 30_000);
});
