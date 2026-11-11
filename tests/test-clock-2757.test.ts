import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestNow } from "../src/lib/test-clock";

const SECRET = "local-clock-secret-2757";
const NOW = "2026-11-30T12:34:56.000Z";
const FALLBACK = Date.parse("2026-10-01T00:00:00.000Z");

function request(value = NOW, secret = SECRET) {
  return new Request("http://localhost/api/deals", { headers: {
    "x-sho-test-now": value,
    "x-sho-test-clock-signature": createHmac("sha256", secret).update(value).digest("hex"),
  } });
}

function enable(database = "postgresql://sho:sho@127.0.0.1:5432/sho_test?schema=public") {
  vi.stubEnv("TEST_CLOCK", "1");
  vi.stubEnv("TEST_CLOCK_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", database);
  vi.stubEnv("NODE_ENV", "test");
}

afterEach(() => vi.unstubAllEnvs());

describe("SHO-2757 signed non-production clock", () => {
  it("uses the signed time only when the local test clock is enabled", () => {
    enable();
    expect(requestNow(request(), FALLBACK)).toBe(Date.parse(NOW));
  });

  it("ignores the header when the flag is off", () => {
    vi.stubEnv("TEST_CLOCK", "0");
    expect(requestNow(request(), FALLBACK)).toBe(FALLBACK);
  });

  it("ignores the header in a production process", () => {
    enable();
    vi.stubEnv("NODE_ENV", "production");
    expect(requestNow(request(), FALLBACK)).toBe(FALLBACK);
  });

  it("ignores the header for every remote database, including staging", () => {
    enable("postgresql://sho:sho@private-sho-db.k.db.ondigitalocean.com:25060/sho_staging?schema=sho_pr9");
    expect(requestNow(request(), FALLBACK)).toBe(FALLBACK);
  });

  it("ignores unsigned, incorrectly signed and malformed times", () => {
    enable();
    expect(requestNow(new Request("http://localhost/api/deals", { headers: { "x-sho-test-now": NOW } }), FALLBACK)).toBe(FALLBACK);
    expect(requestNow(request(NOW, "wrong-local-secret-2757"), FALLBACK)).toBe(FALLBACK);
    expect(requestNow(request("not-a-time"), FALLBACK)).toBe(FALLBACK);
  });
});
