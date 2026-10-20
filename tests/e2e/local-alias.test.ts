// APL-2874: a failed sign-up names the status only, never the server's reply. A stub server on 127.0.0.1
// answers the sign-up, so this runs in `npm test` with no build, no database and no SHO_QA_PASS.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUpAlias } from "./local-alias";

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
