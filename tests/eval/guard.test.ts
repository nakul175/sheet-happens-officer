import { describe, expect, it } from "vitest";
import { assertThrowawayDatabase } from "./guard";

const key = "unit-test-key";
const ok: NodeJS.ProcessEnv = {
  CONCIERGE_EVAL: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://sho:sho@localhost:5432/sho_eval?schema=public",
  MODEL_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: key,
};

describe("concierge eval refuses a non-throwaway database", () => {
  it("accepts a local eval database", () => {
    expect(() => assertThrowawayDatabase(ok)).not.toThrow();
  });

  it("refuses production, remote hosts, the test database, a fake provider and a missing key", () => {
    const cases: NodeJS.ProcessEnv[] = [
      { ...ok, NODE_ENV: "production" },
      { ...ok, DATABASE_URL: "postgresql://sho:secret-pass@db.example.com:5432/sho_eval" },
      { ...ok, DATABASE_URL: "postgresql://sho:sho@localhost:5432/sho_test" },
      { ...ok, MODEL_PROVIDER: "fake" },
      { ...ok, ANTHROPIC_API_KEY: "" },
      { ...ok, CONCIERGE_EVAL: undefined },
      { ...ok, EVAL_MODEL_SLOT: "secondary" },
    ];
    for (const env of cases) {
      let message = "";
      try {
        assertThrowawayDatabase(env);
      } catch (e) {
        message = e instanceof Error ? e.message : "";
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(key);
      expect(message).not.toContain("secret-pass");
      expect(message).not.toContain("postgresql://");
    }
  });
});
