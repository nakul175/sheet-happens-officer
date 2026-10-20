// APL-2874: a failed sign-up names the status only, never the server's reply. A stub server on 127.0.0.1
// answers the sign-up, so this runs in `npm test` with no build, no database and no SHO_QA_PASS.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, QA_PASS, signUpAlias } from "./local-alias";

const SECRET_BODY = "ZZ-TEST-SECRET-BODY";
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    if (req.method === "POST" && req.url === "/api/auth/signup") {
      res.writeHead(409, { "content-type": "text/plain" }).end(SECRET_BODY);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("signUpAlias failed sign-up qa:TC missing", () => {
  it("throws the status only, without the reply body qa:TC missing", async () => {
    const email = `nakul17+zz-test-2874-${Date.now()}@gmail.com`;
    const error = await signUpAlias(base, "/nonexistent-zz-test-outbox", email, "ZZ-TEST Signup 2874", "ZZ-TEST-pass-2874").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toBe(`signup ${email}: 409`);
    expect(error!.message).not.toContain(SECRET_BODY);
  });
});

// APL-2901: the reply-echo check runs whether signUpAlias gets a password argument or falls back to SHO_QA_PASS.
// A second stub answers sign-up, verify and sign-in; `echoAt` names the step whose reply repeats the password it was sent.
describe("signUpAlias reply-echo check (APL-2901) qa:TC missing", () => {
  const PASSWORD = "ZZ-TEST-pass-2901";
  let echoServer: Server;
  let echoBase = "";
  let outbox = "";
  let echoAt = "";
  let requests = 0;

  beforeAll(async () => {
    outbox = mkdtempSync(path.join(tmpdir(), "zz-test-2901-outbox-"));
    echoServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        requests++;
        const sent = (raw ? JSON.parse(raw) : {}) as { password?: string; email?: string };
        const step = req.url ?? "";
        const json = (status: number, body: Record<string, unknown>) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        const echo = step === echoAt ? { password: sent.password ?? PASSWORD } : {};
        if (step === "/api/auth/signup") {
          writeFileSync(path.join(outbox, `${Date.now()}.json`), JSON.stringify({ to: sent.email, subject: "Verify your email", text: "token=zz-test-token" }));
          return json(201, { ok: true, ...echo });
        }
        if (step === "/api/auth/verify") return json(200, { ok: true, ...echo });
        if (step === "/api/auth/signin") return json(200, { user: { id: "zz-test-user", orgRole: "MEMBER" }, ...echo });
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
    echoBase = `http://127.0.0.1:${(echoServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    rmSync(outbox, { recursive: true, force: true });
  });

  const email = (step: string) => `nakul17+zz-test-2901-${step}-${Date.now()}@gmail.com`;

  it.each(["/api/auth/signup", "/api/auth/verify", "/api/auth/signin"])(
    "qa:TC missing AC1: with the password argument, a %s reply that repeats it fails the call",
    async (step) => {
      echoAt = step;
      const error = await signUpAlias(echoBase, outbox, email("echo"), "ZZ-TEST Echo 2901", PASSWORD).then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe(`POST ${step} echoed the password`);
      expect(error!.message).not.toContain(PASSWORD);
    },
  );

  it("qa:TC missing AC1: with the password argument and no echo, the call succeeds", async () => {
    echoAt = "";
    const user = await signUpAlias(echoBase, outbox, email("clean"), "ZZ-TEST Clean 2901", PASSWORD);
    expect(user).toMatchObject({ id: "zz-test-user", orgRole: "MEMBER", name: "ZZ-TEST Clean 2901" });
  });

  it("qa:TC missing AC2: without the password argument the call behaves as on main", async () => {
    // On main the default is SHO_QA_PASS: unset, the call stops before any request; set, an echo of it fails the call.
    echoAt = "/api/auth/signup";
    const before = requests;
    const error = await signUpAlias(echoBase, outbox, email("default"), "ZZ-TEST Default 2901").then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    if (QA_PASS) {
      expect(error!.message).toBe("POST /api/auth/signup echoed the password");
    } else {
      expect(error!.message).toBe("Set SHO_QA_PASS (the password for nakul17+ aliases).");
      expect(requests).toBe(before);
    }
  });

  it("qa:TC missing AC2: call() without a secret checks SHO_QA_PASS only, as on main", async () => {
    echoAt = "/api/auth/verify";
    const answer = await call(echoBase, "", "POST", "/api/auth/verify", { password: PASSWORD });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain(PASSWORD);
  });
});
