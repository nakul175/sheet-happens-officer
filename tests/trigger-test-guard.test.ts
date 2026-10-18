// APL-2700. Unit tests for the guard. No database connection.
import { describe, expect, it } from "vitest";
import { triggerTestAllowed, type TriggerTestTarget } from "./trigger-test-guard";

const local: TriggerTestTarget = {
  host: "localhost",
  database: "sho_test",
  schema: "sho_test_trg_abc",
};

describe("@APL-2700 trigger test guard", () => {
  it("@APL-2700 qa:TC-APL2700-6f0a11d1@v1: allows localhost", () => {
    expect(triggerTestAllowed(local)).toBe(true);
    expect(triggerTestAllowed({ ...local, host: "127.0.0.1" })).toBe(true);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d2@v1: allows throwaway DBs", () => {
    expect(
      triggerTestAllowed({ host: "db.example.com", database: "sho_test_slot", schema: "sho_test_trg_abc" }),
    ).toBe(true);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d3@v1: refuses defaultdb", () => {
    expect(triggerTestAllowed({ ...local, database: "defaultdb" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "defaultdb" }, "1")).toBe(false);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d4@v1: refuses sho_staging", () => {
    expect(triggerTestAllowed({ ...local, database: "sho_staging" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_staging" }, "1")).toBe(false);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d5@v1: refuses a remote host", () => {
    const remote: TriggerTestTarget = { host: "db.example.com", database: "sho_app", schema: "sho_test_trg_abc" };
    expect(triggerTestAllowed(remote)).toBe(false);
    expect(triggerTestAllowed(remote, "1")).toBe(false);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d6@v1: refuses public", () => {
    expect(triggerTestAllowed({ ...local, schema: "public" })).toBe(false);
    expect(triggerTestAllowed({ ...local, schema: "public" }, "1")).toBe(false);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d7@v1: refuses sho_pr1", () => {
    expect(triggerTestAllowed({ ...local, schema: "sho_pr1" })).toBe(false);
    expect(triggerTestAllowed({ ...local, schema: "sho_pr1" }, "1")).toBe(false);
  });
});
