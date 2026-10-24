import { afterEach, expect, it, vi } from "vitest";
import { centralSessionActive } from "../src/lib/central-status";
import { readFlow, sealFlow } from "../src/lib/central-client";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const configure = () => { vi.stubEnv("APLYD_ACCOUNTS_ISSUER", "https://accounts.aplyd.org"); vi.stubEnv("APLYD_ACCOUNTS_CLIENT_SECRET", "owned-test-only-secret-00000000000000000000"); };
it("central status fails closed on wrong issuer without sending credentials", async () => {
  configure(); vi.stubEnv("APLYD_ACCOUNTS_ISSUER", "https://evil.invalid"); const fetcher = vi.fn(); vi.stubGlobal("fetch",fetcher);
  expect(await centralSessionActive("subject", "session", "local")).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { active: true, sub: "subject", local_id: "local", expected: true },
  { active: true, sub: "other", local_id: "local", expected: false },
  { active: true, sub: "subject", local_id: "other", expected: false },
  { active: false, sub: "subject", local_id: "local", expected: false },
])("central status binds both subject and local identity: %j", async ({expected, ...body}) => {
  configure(); vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(body)));
  expect(await centralSessionActive("subject", "session", "local")).toBe(expected);
});
it("network failure refuses linked sessions", async () => {
  configure(); vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("offline")));
  expect(await centralSessionActive("subject", "session", "local")).toBe(false);
});
it("OIDC flow seal preserves nonce/state/verifier and rejects tampering or expiry", () => {
  configure(); const flow = { state: "s".repeat(40), nonce: "n".repeat(40), verifier: "v".repeat(40), expires: Date.now()+60000 };
  const sealed=sealFlow(flow); expect(readFlow(sealed)).toEqual(flow);
  const bytes=Buffer.from(sealed,"base64url"); bytes[30]^=1; expect(()=>readFlow(bytes.toString("base64url"))).toThrow();
  expect(()=>readFlow(sealFlow({...flow,expires:Date.now()-1}))).toThrow();
});
