// Staging mail sink reader (APL-2681). Polls GET /api/qa/mail.
// The token goes in X-QA-Token. Authorization is reserved for Caddy basic auth
// (STAGING_USER / STAGING_PASS) when the e2e config provides it.
// Mailbox-dependent specs skip only when MAIL_SINK_TOKEN is absent:
//   test.skip(!process.env.MAIL_SINK_TOKEN, "MAIL_SINK_TOKEN is not set");

export const MAIL_WAIT_MS = 60_000;

export type SinkMessage = { to: string; subject: string; text: string; sentAt: string };

export type WaitForMailOptions = {
  timeoutMs?: number;
  baseUrl?: string;
  since?: string;
};

/** Specs that need a mailbox skip only when MAIL_SINK_TOKEN is absent. */
export function mailboxSpecsSkip(): boolean {
  return !process.env.MAIL_SINK_TOKEN;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Basic auth for the staging gate when the e2e config names a user, plus the sink token on its own header. */
export function mailSinkHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { "x-qa-token": token };
  const user = process.env.STAGING_USER;
  if (user) {
    const pass = process.env.STAGING_PASS ?? "";
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  }
  return headers;
}

function subjectMatches(subject: string, want: string | RegExp): boolean {
  if (typeof want === "string") return subject === want || subject.includes(want);
  return new RegExp(want.source, want.flags).test(subject);
}

/**
 * Newest captured message for `to` whose subject equals `subject`, contains it, or matches the regular expression.
 * Polls until timeoutMs (default 60s). The error names neither the address, the body, nor the token.
 */
export async function waitForMail(to: string, subject: string | RegExp, options: WaitForMailOptions = {}): Promise<SinkMessage> {
  const token = process.env.MAIL_SINK_TOKEN ?? "";
  if (!token) throw new Error("MAIL_SINK_TOKEN is not set");
  const timeoutMs = options.timeoutMs ?? MAIL_WAIT_MS;
  const base = (options.baseUrl ?? process.env.BASE_URL ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("BASE_URL is not set");
  const deadline = Date.now() + timeoutMs;
  let lastError = "no matching message";
  while (Date.now() <= deadline) {
    try {
      const url = new URL("/api/qa/mail", base);
      url.searchParams.set("to", to);
      if (options.since) url.searchParams.set("since", options.since);
      const res = await fetch(url, {
        headers: mailSinkHeaders(token),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 200) {
        const messages = (await res.json()) as SinkMessage[];
        const hit = Array.isArray(messages) ? messages.find((message) => subjectMatches(message.subject ?? "", subject)) : undefined;
        if (hit?.text) return hit;
        lastError = "no matching message";
      } else if (res.status === 404 || res.status === 401 || res.status === 400) {
        throw new Error(`Mail sink returned HTTP ${res.status}`);
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Mail sink returned HTTP")) throw err;
      lastError = "request failed";
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(250, deadline - Date.now()));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for mail (${lastError})`);
}
