import { createRequire } from "node:module";
import { Client } from "pg";
import { expect, it } from "vitest";
import { assertLocalFixture } from "./e2e/local-fixture-guard";

const require = createRequire(import.meta.url);
const { observeRestoreCounts } = require("../deploy/restore-observation.cjs") as {
  observeRestoreCounts: (client: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<{ out: Record<string, number> }>;
};

it("uses a real PostgreSQL read-only snapshot on the disposable CI database", async () => {
  const url = process.env.DATABASE_URL;
  assertLocalFixture(url);
  const client = new Client({ connectionString: url });
  let sawReadOnly = false;
  try {
    await client.connect();
    const result = await observeRestoreCounts({ query: async (sql: string) => {
      if (sql.includes("from pg_tables")) {
        const state = await client.query("show transaction_read_only");
        expect(state.rows[0].transaction_read_only).toBe("on");
        sawReadOnly = true;
      }
      return client.query(sql);
    } });
    expect(sawReadOnly).toBe(true);
    expect(result.out.User).toBeGreaterThanOrEqual(0);
  } finally {
    await client.end().catch(() => {});
  }
});
