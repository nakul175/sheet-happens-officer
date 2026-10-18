import { describe, expect, it } from "vitest";
import { Client } from "./helpers";

describe("version", () => {
  it("returns the running git SHA and artifact digest", async () => {
    const r = await new Client().get("/api/version");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    const sha = process.env.RELEASE || null;
    const digest = process.env.ARTIFACT_SHA256 || null;
    expect(r.json).toEqual({ sha, digest });
    if (sha !== null) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    if (digest !== null) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.json)).not.toMatch(/postgres(ql)?:\/\//);
  });
});
