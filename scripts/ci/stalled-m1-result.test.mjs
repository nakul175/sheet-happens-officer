import test from "node:test";
import assert from "node:assert/strict";
import { validateStalledM1 } from "./stalled-m1-result.mjs";
const source = "// fixture\nexpect(second.after).toEqual(second.before);\n";
const failure = title => ({ title, status: "failed", failureMessages: ["AssertionError: expected [ { …(9) } ] to deeply equal []\n at tests/jobs-stalled-crm.test.ts:2:3"] });
const valid = () => ({ testResults: [{ assertionResults: [failure("all preserves exact world notices"), failure("admins hides non-admin deals"), { status: "skipped" }] }] });
test("accepts actual Vitest abbreviated messages only at the exact row assertion", () => assert.equal(validateStalledM1(valid(), source).length, 2));
for (const [name, change] of [
  ["fixture failure", r => { r.testResults[0].assertionResults[0].failureMessages = ["Error: seed failed"]; }],
  ["wrong assertion", r => { r.testResults[0].assertionResults[0].failureMessages[0] = r.testResults[0].assertionResults[0].failureMessages[0].replace(":2:3", ":1:3"); }],
  ["additional cleanup error", r => { r.testResults[0].assertionResults[0].failureMessages.push("cleanup failed"); }],
  ["one missed mutation", r => { r.testResults[0].assertionResults[0].status = "passed"; }],
  ["unrelated failed test", r => { r.testResults[0].assertionResults.push(failure("unrelated")); }],
]) test(`refuses ${name}`, () => { const r = valid(); change(r); assert.throws(() => validateStalledM1(r, source)); });
