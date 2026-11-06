import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db }));

import { qaMailResponse, sinkMode } from "@/lib/mail-sink";
import { POST as qaAccounts } from "@/app/api/qa/accounts/route";

const staging = {
  MAIL_SINK: "staging",
  MAIL_SINK_TOKEN: "synthetic-qa-token",
  NODE_ENV: "production",
  APP_URL: "https://staging.sheethappensofficer.com",
  EMAIL_OUTBOX_DIR: "/tmp/synthetic-qa-mail",
  DATABASE_URL: "postgresql://synthetic:synthetic@db.example:25060/sho_staging?sslmode=require",
} as const;

describe("QA mail sink database containment", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("rejects a staging-looking app wired to the production database", () => {
    expect(sinkMode({ ...staging, DATABASE_URL: "postgresql://synthetic:synthetic@db.example:25060/defaultdb?sslmode=require" }).active).toBe(false);
  });

  it("rejects a missing or ambiguous runtime database", () => {
    expect(sinkMode({ ...staging, DATABASE_URL: "" }).active).toBe(false);
    expect(sinkMode({ ...staging, DATABASE_URL: "postgresql://synthetic:synthetic@db.example:25060/other_db" }).active).toBe(false);
  });

  it("accepts only a fully armed staging app on sho_staging", () => {
    expect(sinkMode(staging).active).toBe(true);
    expect(sinkMode({ ...staging, APP_URL: "https://sheethappensofficer.aplyd.org" }).active).toBe(false);
    expect(sinkMode({ ...staging, APP_URL: "http://127.0.0.1:3109", SHO_DEPLOY_STAGE: "staging", SHO_SLOT: "9" }).active).toBe(true);
  });

  it("returns 404 from both QA routes before touching data on a production database", async () => {
    for (const [key, value] of Object.entries({ ...staging, DATABASE_URL: "postgresql://synthetic:synthetic@db.example:25060/defaultdb" })) {
      vi.stubEnv(key, value);
    }
    const headers = { "x-qa-token": "synthetic-qa-token" };
    const mail = await qaMailResponse(new Request("https://staging.sheethappensofficer.com/api/qa/mail?to=zz-test@example.com", { headers }));
    const accounts = await qaAccounts(new Request("https://staging.sheethappensofficer.com/api/qa/accounts", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ accounts: [{ email: "zz-test@example.com", password: "Synthetic123", role: "ADMIN" }] }),
    }));
    expect(mail.status).toBe(404);
    expect(accounts.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
