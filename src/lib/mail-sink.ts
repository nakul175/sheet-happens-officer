import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Hosts from .github/workflows/staging-e2e.yml (TARGET_ALLOWLIST). Production is not on this list. */
const STAGING_HOST = /^(staging\.sheethappensofficer\.com|pr[1-4]\.staging\.sheethappensofficer\.com)$/;

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type SinkMessage = { to: string; subject: string; text: string; sentAt: string };

type Outbound = { to: string; subject: string; text: string };

type SinkMode =
  | { active: false; armed: false }
  | { active: false; armed: true; reason: string }
  | { active: true; token: string; dir: string };

/**
 * A ZZ test address. The local part carries zz-test / zz.test / zz_test / zztest,
 * or a plus-tag that starts with zz (the nakul17+zz- aliases the story specs use).
 * Compared case-insensitively. Anything else is not stored and cannot be queried.
 */
export function isZzTestAddress(to: string): boolean {
  const value = to.trim().toLowerCase();
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false;
  if (/(^|[^a-z0-9])zz[-._]?test([0-9]|$|[^a-z0-9])/.test(local)) return true;
  const plus = local.lastIndexOf("+");
  if (plus <= 0) return false;
  const tag = local.slice(plus + 1);
  return tag === "zz" || /^zz[-._]/.test(tag) || /^zz[0-9]/.test(tag);
}

/** SHA-256 digests are equal length, so timingSafeEqual never throws on a short or long guess. */
export function tokensEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(header: string | null): string {
  if (!header) return "";
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1] ?? "";
}

function appHost(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    return new URL(appUrl).hostname.replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** MAIL_SINK unset: inert. Set to anything that is not a full staging configuration: armed and refused. */
export function sinkMode(env: NodeJS.ProcessEnv = process.env): SinkMode {
  const flag = env.MAIL_SINK;
  if (!flag) return { active: false, armed: false };
  if (flag !== "staging") return { active: false, armed: true, reason: 'MAIL_SINK must be exactly "staging"' };
  const token = env.MAIL_SINK_TOKEN ?? "";
  if (!token) return { active: false, armed: true, reason: "MAIL_SINK_TOKEN is empty" };
  const host = appHost(env.APP_URL);
  if (!host || !STAGING_HOST.test(host)) {
    return { active: false, armed: true, reason: `APP_URL host is not a staging host (${host ?? "missing or invalid"})` };
  }
  const dir = env.EMAIL_OUTBOX_DIR ?? "";
  if (!dir) return { active: false, armed: true, reason: "EMAIL_OUTBOX_DIR is empty" };
  return { active: true, token, dir };
}

export function sinkActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return sinkMode(env).active;
}

/**
 * Staging capture. Throws when MAIL_SINK is set but the sink is not fully active.
 * Never calls Resend. Writes only ZZ test recipients; other recipients are dropped.
 */
export async function deliverSinkMail(mail: Outbound, from: string): Promise<void> {
  const mode = sinkMode();
  if (!mode.active) {
    const reason = mode.armed ? mode.reason : "MAIL_SINK is unset";
    throw new Error(`Mail sink refused to send (${reason}). Nothing was sent or stored.`);
  }
  if (!isZzTestAddress(mail.to)) {
    console.info("mail sink dropped a message for a non-ZZ recipient");
    return;
  }
  await mkdir(mode.dir, { recursive: true });
  const sentAt = new Date().toISOString();
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await writeFile(
    path.join(mode.dir, name),
    JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text, from, sentAt }, null, 2),
  );
}

const noStore = { "cache-control": "no-store" };

/** GET /api/qa/mail. 404 unless the sink is active. Does not log the query, the token, or message bodies. */
export async function qaMailResponse(req: Request): Promise<Response> {
  const mode = sinkMode();
  if (!mode.active) return Response.json({ error: "Not found" }, { status: 404, headers: noStore });
  if (!tokensEqual(bearerToken(req.headers.get("authorization")), mode.token)) {
    return Response.json({ error: "Not allowed" }, { status: 401, headers: noStore });
  }
  const url = new URL(req.url);
  const to = url.searchParams.get("to") ?? "";
  if (!isZzTestAddress(to)) {
    return Response.json({ error: "to must be a ZZ test address" }, { status: 400, headers: noStore });
  }
  const sinceRaw = url.searchParams.get("since");
  let since = Number.NEGATIVE_INFINITY;
  if (sinceRaw) {
    const parsed = Date.parse(sinceRaw);
    if (Number.isNaN(parsed)) {
      return Response.json({ error: "since must be an ISO timestamp" }, { status: 400, headers: noStore });
    }
    since = parsed;
  }
  await purgeOld(mode.dir);
  const messages = await readMatching(mode.dir, to, since);
  return Response.json(messages, { headers: noStore });
}

async function purgeOld(dir: string, now = Date.now()): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.map(async (name) => {
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) return;
      let at = info.mtimeMs;
      if (name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(await readFile(full, "utf8")) as { sentAt?: unknown };
          if (typeof parsed.sentAt === "string") {
            const sent = Date.parse(parsed.sentAt);
            if (!Number.isNaN(sent)) at = sent;
          }
        } catch { /* fall back to mtime */ }
      }
      if (now - at > MAX_AGE_MS) await unlink(full);
    } catch { /* a file removed between readdir and unlink */ }
  }));
}

async function readMatching(dir: string, to: string, since: number): Promise<SinkMessage[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const want = to.trim().toLowerCase();
  const rows: { file: string; message: SinkMessage }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as Partial<SinkMessage>;
      if (typeof parsed.to !== "string" || parsed.to.trim().toLowerCase() !== want) continue;
      if (typeof parsed.subject !== "string" || typeof parsed.text !== "string" || typeof parsed.sentAt !== "string") continue;
      const sent = Date.parse(parsed.sentAt);
      if (Number.isNaN(sent) || sent < since) continue;
      rows.push({ file: name, message: { to: parsed.to, subject: parsed.subject, text: parsed.text, sentAt: parsed.sentAt } });
    } catch { /* half-written file; the next read will see it */ }
  }
  rows.sort((a, b) => b.message.sentAt.localeCompare(a.message.sentAt) || b.file.localeCompare(a.file));
  return rows.map((row) => row.message);
}
