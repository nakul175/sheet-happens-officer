// APL-2681. The staging mail sink is off unless MAIL_SINK, the token, and the host all agree.
// Fixtures use ZZ-TEST names and zz test addresses. No real token or password is used.
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compared: Array<[number, number]> = [];

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    timingSafeEqual(a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) {
      compared.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

vi.mock("next/server", () => ({
  connection: () => Promise.resolve(),
}));

import { resetMail, sendMail, signInDetailsMail, verifyMail } from "../src/lib/email";
import { isZzTestAddress, qaMailResponse } from "../src/lib/mail-sink";
import { MAIL_WAIT_MS, mailSinkHeaders, mailboxSpecsSkip, waitForMail } from "./mail-sink-client";

const TOKEN = "zz-test-sink-token";
const PASSWORD = "ZzTemp9only";
const ZZ_TO = "zz-test-ac1@example.com";
const OTHER_TO = "not-a-zz-recipient@example.com";
const STAGING = "https://staging.sheethappensofficer.com";
const ENV_KEYS = ["MAIL_SINK", "MAIL_SINK_TOKEN", "EMAIL_OUTBOX_DIR", "APP_URL", "RESEND_API_KEY", "NODE_ENV", "BASE_URL", "EMAIL_FROM", "STAGING_USER", "STAGING_PASS"] as const;

let restoreEnv: () => void;
let outbox: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const originalFetch = globalThis.fetch.bind(globalThis);

function captureLogs() {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
    }),
  );
  return {
    lines,
    text: () => lines.join("\n"),
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

async function files(): Promise<string[]> {
  try {
    return await readdir(outbox);
  } catch {
    return [];
  }
}

function arm(over: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
  process.env.MAIL_SINK = "staging";
  process.env.MAIL_SINK_TOKEN = TOKEN;
  process.env.EMAIL_OUTBOX_DIR = outbox;
  process.env.APP_URL = STAGING;
  process.env.RESEND_API_KEY = "zz-test-resend-key";
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function endpoint(url: string, token?: string, extra?: Record<string, string>) {
  const headers = new Headers(extra);
  if (token !== undefined) headers.set("x-qa-token", token);
  const response = await qaMailResponse(new Request(url, { headers }));
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, text };
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    try {
      const response = await qaMailResponse(new Request(`http://${req.headers.host}${req.url}`, { headers }));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.statusCode = 500;
      res.end("");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

beforeEach(async () => {
  compared.length = 0;
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  restoreEnv = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  outbox = await mkdtemp(path.join(tmpdir(), "sho-sink-"));
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.resend.com")) return Promise.resolve(new Response("{}", { status: 200 }));
    return originalFetch(input, init);
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  restoreEnv();
  await rm(outbox, { recursive: true, force: true });
});

function resendCalls() {
  return fetchSpy.mock.calls.filter((call: readonly unknown[]) => String(call[0]).includes("api.resend.com"));
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("AC1 staging mail is captured", () => {
  // qa:TC missing
  it("writes verify, reset and sign-in details for a ZZ test address and serves them within 60s", async () => {
    arm();
    const logs = captureLogs();
    try {
      await sendMail(verifyMail(ZZ_TO, "zz-verify-token"));
      await pause();
      await sendMail(resetMail(ZZ_TO, "zz-reset-token"));
      await pause();
      await sendMail(signInDetailsMail(ZZ_TO, "ZZ-TEST", "A Super Admin", PASSWORD));
      await sendMail(signInDetailsMail(OTHER_TO, "ZZ-TEST", "A Super Admin", PASSWORD));
      expect(resendCalls()).toEqual([]);
      const stored = await Promise.all((await files()).map(async (name) => JSON.parse(await readFile(path.join(outbox, name), "utf8")) as { to: string }));
      expect(stored.every((mail) => mail.to === ZZ_TO)).toBe(true);
      expect(stored).toHaveLength(3);
      expect(JSON.stringify(stored)).not.toContain(OTHER_TO);

      const started = Date.now();
      await withServer(async (baseUrl) => {
        const verify = await waitForMail(ZZ_TO, "Verify your email for Sheet Happens Officer", { timeoutMs: 60_000, baseUrl });
        const reset = await waitForMail(ZZ_TO, /Reset your Sheet Happens Officer password/, { timeoutMs: 60_000, baseUrl });
        const details = await waitForMail(ZZ_TO, "Your Sheet Happens Officer account", { timeoutMs: 60_000, baseUrl });
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(verify.text).toContain("zz-verify-token");
        expect(reset.text).toContain("zz-reset-token");
        expect(details.text).toContain(PASSWORD);
        expect(details.to).toBe(ZZ_TO);
        const listed = await endpoint(`${baseUrl}/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}`, TOKEN);
        expect(listed.status).toBe(200);
        expect(Array.isArray(listed.json)).toBe(true);
        expect((listed.json as { subject: string }[])[0].subject).toBe("Your Sheet Happens Officer account");
      });
      const blob = logs.text();
      expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain(PASSWORD);
      expect(blob).not.toContain(OTHER_TO);
      expect(blob).not.toContain("zz-verify-token");
      expect(blob).toContain("mail sink dropped a message for a non-ZZ recipient");
      expect(blob).not.toContain("Password:");
    } finally {
      logs.restore();
    }
  });

  // qa:TC missing
  it("accepts the staging and pr1-pr4 hosts and stores a plus-tag ZZ address", async () => {
    for (const host of ["staging.sheethappensofficer.com", "pr1.staging.sheethappensofficer.com", "pr4.staging.sheethappensofficer.com"]) {
      arm({ APP_URL: `https://${host}` });
      await sendMail(verifyMail("nakul17+zz-2681-ac1@example.com", "zz-verify-token"));
    }
    expect(resendCalls()).toEqual([]);
    expect(await files()).toHaveLength(3);
    expect(isZzTestAddress("nakul17+zz-2681-ac1@example.com")).toBe(true);
    expect(isZzTestAddress(OTHER_TO)).toBe(false);
    expect(isZzTestAddress("buzztest@example.com")).toBe(false);
  });
});

describe("production fail-closed", () => {
  async function refuses(over: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, pattern: RegExp) {
    const dir = path.join(outbox, "unused");
    arm({ EMAIL_OUTBOX_DIR: dir, RESEND_API_KEY: "zz-test-resend-key", ...over });
    const logs = captureLogs();
    try {
      await expect(sendMail(signInDetailsMail(ZZ_TO, "ZZ-TEST", "A Super Admin", PASSWORD))).rejects.toThrow(pattern);
      expect(resendCalls()).toEqual([]);
      await expect(stat(dir)).rejects.toThrow();
      const blob = logs.text();
      expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain(PASSWORD);
      expect(blob).not.toContain(ZZ_TO);
    } finally {
      logs.restore();
    }
  }

  // qa:TC missing
  it("MAIL_SINK=staging on the production host throws and writes nothing", async () => {
    await refuses({ APP_URL: "https://app.sheethappensofficer.com" }, /not a staging host/);
    const denied = await endpoint(`http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}`, TOKEN);
    expect(denied.status).toBe(404);
  });

  // qa:TC missing
  it("an empty token throws and writes nothing", async () => {
    await refuses({ MAIL_SINK_TOKEN: "" }, /MAIL_SINK_TOKEN is empty/);
  });

  // qa:TC missing
  it("an unknown host throws and writes nothing", async () => {
    await refuses({ APP_URL: "https://unknown.example" }, /not a staging host/);
    await refuses({ APP_URL: "https://staging.sheethappensofficer.com.evil.example" }, /not a staging host/);
    await refuses({ APP_URL: "https://pr5.staging.sheethappensofficer.com" }, /not a staging host/);
  });

  // qa:TC missing
  it("a MAIL_SINK value other than staging throws and does not fall back", async () => {
    await refuses({ MAIL_SINK: "on" }, /exactly "staging"/);
  });

  // qa:TC missing
  it("MAIL_SINK unset keeps the existing outbox and Resend paths", async () => {
    arm({ MAIL_SINK: undefined, RESEND_API_KEY: undefined, NODE_ENV: "test" });
    await sendMail(verifyMail(ZZ_TO, "zz-verify-token"));
    expect(resendCalls()).toEqual([]);
    const names = await files();
    expect(names).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(outbox, names[0]), "utf8")) as { to: string; subject: string; text: string; from: string; sentAt?: string };
    expect(saved.to).toBe(ZZ_TO);
    expect(saved.subject).toContain("Verify");
    expect(saved.text).toContain("zz-verify-token");
    expect(saved.from).toContain("no-reply@sheethappensofficer.com");
    expect(saved.sentAt).toBeUndefined();

    await rm(path.join(outbox, names[0]));
    process.env.RESEND_API_KEY = "zz-test-resend-key";
    await sendMail(resetMail(ZZ_TO, "zz-reset-token"));
    expect(resendCalls()).toHaveLength(1);
    expect(await files()).toEqual([]);

    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_OUTBOX_DIR;
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    await expect(sendMail(verifyMail(ZZ_TO, "zz-verify-token"))).rejects.toThrow("RESEND_API_KEY is not set");
  });
});

describe("AC2 waitForMail and the endpoint", () => {
  // qa:TC missing
  it("waitForMail resolves for a captured message and times out cleanly", async () => {
    expect(MAIL_WAIT_MS).toBe(60_000);
    arm();
    await sendMail(verifyMail(ZZ_TO, "zz-verify-token"));
    await withServer(async (baseUrl) => {
      const found = await waitForMail(ZZ_TO, /Verify your email/, { baseUrl });
      expect(found.subject).toContain("Verify");
      expect(found.text).toContain("zz-verify-token");
      const started = Date.now();
      await expect(waitForMail(ZZ_TO, "no-such-subject", { timeoutMs: 300, baseUrl })).rejects.toThrow(/Timed out after 300ms/);
      expect(Date.now() - started).toBeLessThan(5_000);
      try {
        await waitForMail(ZZ_TO, "no-such-subject", { timeoutMs: 50, baseUrl });
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(TOKEN);
        expect(message).not.toContain(PASSWORD);
        expect(message).not.toContain(ZZ_TO);
      }
    });
  });

  // qa:TC missing
  it("is 404 when the sink is off, 401 for a wrong or missing token, and 400 for a non-ZZ address", async () => {
    arm({ MAIL_SINK: undefined });
    expect((await endpoint(`http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}`, TOKEN)).status).toBe(404);

    arm();
    const mailUrl = `http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}`;
    expect((await endpoint(mailUrl)).status).toBe(401);
    expect((await endpoint(mailUrl, "")).status).toBe(401);
    expect((await endpoint(mailUrl, undefined, { authorization: `Bearer ${TOKEN}` })).status).toBe(401);
    expect((await endpoint(`http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(OTHER_TO)}`, TOKEN)).status).toBe(400);
    expect((await endpoint(`http://127.0.0.1/api/qa/mail?to=`, TOKEN)).status).toBe(400);
    const basic = Buffer.from("zz-test-gate:zz-test-pass", "utf8").toString("base64");
    expect((await endpoint(mailUrl, TOKEN, { authorization: `Basic ${basic}` })).status).toBe(200);
    expect(mailboxSpecsSkip()).toBe(false);
    delete process.env.MAIL_SINK_TOKEN;
    expect(mailboxSpecsSkip()).toBe(true);
  });

  // qa:TC missing
  it("purges outbox files older than 24h when the mailbox is read", async () => {
    arm();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(path.join(outbox, "old.json"), JSON.stringify({ to: ZZ_TO, subject: "Old", text: "stale", sentAt: stale }));
    await sendMail(verifyMail(ZZ_TO, "zz-verify-token"));
    const listed = await endpoint(`http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}&since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, TOKEN);
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect((listed.json as { subject: string }[])[0].subject).toContain("Verify");
    expect(await files()).not.toContain("old.json");
  });

  // qa:TC missing
  it("waitForMail sends X-QA-Token and basic auth when the e2e config provides it", async () => {
    arm();
    process.env.STAGING_USER = "zz-test-gate";
    process.env.STAGING_PASS = "zz-test-pass";
    await sendMail(verifyMail(ZZ_TO, "zz-verify-token"));
    const basic = Buffer.from("zz-test-gate:zz-test-pass", "utf8").toString("base64");
    await withServer(async (baseUrl) => {
      await waitForMail(ZZ_TO, /Verify your email/, { baseUrl, timeoutMs: 5_000 });
    });
    const sent = fetchSpy.mock.calls.find((item: readonly unknown[]) => String(item[0]).includes("/api/qa/mail"));
    const headers = new Headers((sent?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("x-qa-token")).toBe(TOKEN);
    expect(headers.get("authorization")).toBe(`Basic ${basic}`);
    expect(headers.get("authorization")).not.toContain(TOKEN);
    expect(mailSinkHeaders(TOKEN)).toEqual({ "x-qa-token": TOKEN, authorization: `Basic ${basic}` });

    delete process.env.STAGING_USER;
    delete process.env.STAGING_PASS;
    fetchSpy.mockClear();
    await withServer(async (baseUrl) => {
      await waitForMail(ZZ_TO, /Verify your email/, { baseUrl, timeoutMs: 5_000 });
    });
    const plain = fetchSpy.mock.calls.find((item: readonly unknown[]) => String(item[0]).includes("/api/qa/mail"));
    const plainHeaders = new Headers((plain?.[1] as RequestInit | undefined)?.headers);
    expect(plainHeaders.get("x-qa-token")).toBe(TOKEN);
    expect(plainHeaders.get("authorization")).toBeNull();
  });

  // qa:TC missing
  it("skips outbox files over 256 KB and returns at most the newest 20", async () => {
    arm();
    await writeFile(path.join(outbox, "big.json"), JSON.stringify({
      to: ZZ_TO,
      subject: "TOO-BIG",
      text: "x".repeat(256 * 1024),
      sentAt: new Date().toISOString(),
    }));
    expect((await stat(path.join(outbox, "big.json"))).size).toBeGreaterThan(256 * 1024);
    const start = Date.now() - 21_000;
    for (let i = 0; i < 21; i++) {
      const sentAt = new Date(start + i * 1000).toISOString();
      await writeFile(path.join(outbox, `n-${String(i).padStart(2, "0")}.json`), JSON.stringify({
        to: ZZ_TO,
        subject: `n-${i}`,
        text: "zz-test body",
        sentAt,
      }));
    }
    const listed = await endpoint(`http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}`, TOKEN);
    expect(listed.status).toBe(200);
    const messages = listed.json as { subject: string; text: string }[];
    const subjects = messages.map((message) => message.subject);
    expect(messages).toHaveLength(20);
    expect(subjects).not.toContain("TOO-BIG");
    expect(subjects).not.toContain("n-0");
    expect(subjects[0]).toBe("n-20");
    expect(subjects).toContain("n-1");
    expect(messages.some((message) => message.text.length > 256 * 1024)).toBe(false);
  });
});

describe("constant-time token compare", () => {
  // qa:TC missing
  it("a wrong token of the same length and of a different length is 401 and does not throw", async () => {
    arm();
    const sameLength = "zz-test-sink-tokEn";
    expect(sameLength.length).toBe(TOKEN.length);
    const longer = `${TOKEN}-extra`;
    expect(longer.length).not.toBe(TOKEN.length);
    for (const guess of [sameLength, longer, "no", TOKEN]) {
      const result = await endpoint(`http://127.0.0.1/api/qa/mail?to=${encodeURIComponent(ZZ_TO)}`, guess);
      expect(result.status, guess).toBe(guess === TOKEN ? 200 : 401);
    }
    expect(compared.length).toBeGreaterThan(0);
    for (const [left, right] of compared) {
      expect(left).toBe(right);
      expect(left).toBeGreaterThan(0);
    }
  });
});

describe("AC3 logs", () => {
  // qa:TC missing
  it("does not log the sink token, the password, or a dropped address or body", async () => {
    arm();
    const logs = captureLogs();
    try {
      await sendMail(signInDetailsMail(ZZ_TO, "ZZ-TEST", "A Super Admin", PASSWORD));
      await sendMail(signInDetailsMail(OTHER_TO, "Pat", "A Super Admin", PASSWORD));
      const blob = logs.text();
      expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain(PASSWORD);
      expect(blob).not.toContain(OTHER_TO);
      expect(blob).not.toContain(ZZ_TO);
      expect(blob).not.toContain("Do not forward");
      expect(blob).not.toContain("Password:");
      expect(blob).toBe("mail sink dropped a message for a non-ZZ recipient");
    } finally {
      logs.restore();
    }
  });
});
