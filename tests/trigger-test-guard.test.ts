// APL-2700. Unit tests for the guard. No database connection.
//
// Test-case ids. A title carrying `qa:TC-<TICKET>-<8 hex>@v<n>` is the QA-assigned traceability tag for that
// case (the APL-2700 cases below carry qa:TC-APL2700-6f0a11d1..d9). QA assigns the id for a case; nothing in
// this repo mints, lists or derives one. There is no registry, generator, fixture or doc holding the ids, and
// a `git log -S'qa:TC-APL2764'` over every ref finds nothing, so an id QA has not assigned cannot be looked up
// here. A title ending `qa:TC missing` is a case whose id is still outstanding: leave the marker, do not
// invent an id.
import { describe, expect, it } from "vitest";
import { connectionTarget, triggerTestAllowed, triggerUrlAllowed, type TriggerTestTarget } from "./trigger-test-guard";

const local: TriggerTestTarget = {
  host: "localhost",
  database: "sho_test_slot",
  schema: "sho_test_trg_abc",
};

describe("@APL-2700 trigger test guard", () => {
  it("@APL-2700 qa:TC-APL2700-6f0a11d1@v1: allows localhost and 127.0.0.1 when the database is sho_test_*", () => {
    expect(triggerTestAllowed(local)).toBe(true);
    expect(triggerTestAllowed({ ...local, host: "127.0.0.1" })).toBe(true);
  });

  // TODO(SHO-2878): this APL-2764 case (1 of 2) has no QA-assigned test-case id. To close it, QA must assign
  // one id of the form qa:TC-APL2764-<8 hex>@v1 for "allows the CI database sho_test exactly, and nothing else
  // that only resembles it", then that id replaces the `qa:TC missing` marker at the end of the title below.
  // It cannot be pinned from this repo: see the header note on test-case ids.
  it("@APL-2764 allows the CI database sho_test exactly, and nothing else that only resembles it qa:TC missing", () => {
    expect(triggerTestAllowed({ ...local, database: "sho_test" })).toBe(true);
    expect(triggerTestAllowed({ ...local, database: "SHO_TEST" })).toBe(true);
    expect(triggerTestAllowed({ ...local, host: "127.0.0.1", database: "sho_test" })).toBe(true);
    expect(triggerTestAllowed({ ...local, database: "sho_testing" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_test2" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "xsho_test" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_tes" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_app" })).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_staging" }, "1")).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "defaultdb" }, "1")).toBe(false);
  });

  // TODO(SHO-2878): this APL-2764 case (2 of 2) has no QA-assigned test-case id. To close it, QA must assign
  // one id of the form qa:TC-APL2764-<8 hex>@v1 for "refuses sho_test on a remote host, with public or sho_pr*
  // schemas, or via a query override", then that id replaces the `qa:TC missing` marker at the end of the title
  // below. It cannot be pinned from this repo: see the header note on test-case ids.
  it("@APL-2764 refuses sho_test on a remote host, with public or sho_pr* schemas, or via a query override qa:TC missing", () => {
    expect(triggerTestAllowed({ ...local, host: "db.example.com", database: "sho_test" }, "1")).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_test", schema: "public" }, "1")).toBe(false);
    expect(triggerTestAllowed({ ...local, database: "sho_test", schema: "sho_pr7" }, "1")).toBe(false);
    const schema = "sho_test_trg_abc";
    expect(triggerUrlAllowed("postgresql://sho:sho@localhost:5432/sho_test?schema=public", schema)).toBe(true);
    expect(triggerUrlAllowed("postgresql://sho:sho@localhost:5432/sho_test?host=staging.db.internal", schema, "1")).toBe(false);
    expect(triggerUrlAllowed("postgresql://sho:sho@localhost:5432/sho_test?dbname=defaultdb", schema, "1")).toBe(false);
    expect(triggerUrlAllowed("postgresql://sho:sho@db.example.com:5432/sho_test", schema, "1")).toBe(false);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d2@v1: refuses a remote host even when the database is sho_test_*", () => {
    const remote: TriggerTestTarget = { host: "db.example.com", database: "sho_test_slot", schema: "sho_test_trg_abc" };
    expect(triggerTestAllowed(remote)).toBe(false);
    expect(triggerTestAllowed(remote, "1")).toBe(false);
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

  it("@APL-2700 qa:TC-APL2700-6f0a11d8@v1: refuses postgresql://u:p@localhost:5432/sho_app?host=staging.db.internal", () => {
    const raw = "postgresql://u:p@localhost:5432/sho_app?host=staging.db.internal";
    expect(connectionTarget(raw, "sho_test_trg_abc")).toBeUndefined();
    expect(triggerUrlAllowed(raw, "sho_test_trg_abc")).toBe(false);
    expect(triggerUrlAllowed(raw, "sho_test_trg_abc", "1")).toBe(false);
  });

  it("@APL-2700 qa:TC-APL2700-6f0a11d9@v1: refuses hostaddr, dbname, and socket paths", () => {
    const schema = "sho_test_trg_abc";
    expect(connectionTarget("postgresql://u:p@localhost:5432/sho_test_slot?hostaddr=10.0.0.5", schema)).toBeUndefined();
    expect(connectionTarget("postgresql://u:p@localhost:5432/sho_test_slot?dbname=defaultdb", schema)).toBeUndefined();
    expect(connectionTarget("/var/run/postgresql sho_test_slot", schema)).toBeUndefined();
    expect(connectionTarget("postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/sho_test_slot", schema)).toBeUndefined();
    expect(triggerUrlAllowed("postgresql://u:p@127.0.0.1:5432/sho_test_slot", schema)).toBe(true);
    expect(triggerUrlAllowed("postgresql://u:p@db.example.com:5432/sho_test_slot", schema, "1")).toBe(false);
  });
});
