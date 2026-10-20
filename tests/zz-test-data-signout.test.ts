// APL-2893. cleanUp() signs its root.test Super Admin session out through the app API when it is done,
// and still archives and deactivates the ZZ-TEST data it made. No qa:TC id is assigned, so the title says qa:TC missing.
import { afterAll, describe, expect, it, vi } from "vitest";
import { BASE, SUPER_EMAIL } from "./helpers";
import { zzTestData } from "./zz-test-data";

const zz = zzTestData("2893");
let cleaned = false;

afterAll(async () => {
  if (cleaned) return;
  const problems = await zz.cleanUp();
  expect(problems, problems.join("\n")).toEqual([]);
}, 120000);

/** GET /api/auth/me with exactly this session cookie. */
const me = (cookie: string) => fetch(BASE + "/api/auth/me", { headers: { cookie } });

describe("APL-2893 cleanUp() signs the Super Admin out", () => {
  it("qa:TC missing: the session cleanUp() signed in with is signed out, and the ZZ-TEST data is still cleaned up", async () => {
    const leader = await zz.person("Leader");
    await zz.project(leader);

    // Record the session cookie the root.test sign-in hands back while cleanUp() runs.
    const sessions: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await real(input, init);
      const url = String(input instanceof Request ? input.url : input);
      const email = typeof init?.body === "string" ? JSON.parse(init.body).email : undefined;
      const set = res.headers.get("set-cookie");
      if (url.endsWith("/api/auth/signin") && email === SUPER_EMAIL && res.status === 200 && set) sessions.push(set.split(";")[0]);
      return res;
    });
    let problems: string[];
    try {
      problems = await zz.cleanUp();
    } finally {
      spy.mockRestore();
    }
    cleaned = true;

    expect(problems, problems.join("\n")).toEqual([]);
    expect(sessions).toHaveLength(1);
    const old = await me(sessions[0]);
    expect(old.status, "the old Super Admin session still works after cleanUp()").toBe(401);
    expect((await old.json()).error).toBe("Not signed in");

    // The ZZ-TEST person was deactivated through the API, so their own session is turned away too.
    expect((await leader.c.get("/api/auth/me")).status).toBe(401);
  }, 120000);
});
