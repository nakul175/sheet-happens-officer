// SHO-2693: the required-person flag is a flag, and a proposal's Change object is not one.
// Honest history (re-review w70): the parent 597f67d refused a person-less proposal already — `person(c, required = true)`
// with `required ? reject("person_id is missing. …")`, called with one argument. The object-reading form
// `typeof o === "object" ? o.required : o` came in with f3a4c03's options-bag spelling of the parameter, was never
// reachable from a call site (each one passed an explicit boolean), and d89ef4b removed it. These cases are therefore a
// fail-closed guard on the exported helper for future callers, not the proof of a shipped defect: only an explicit
// `false` asks for an optional person; anything else keeps the requirement on, so a proposal that names nobody is
// refused instead of becoming a card that assigns nobody. See W70-REPORT.md.
import { describe, expect, it } from "vitest";
import { requiredPerson } from "../src/lib/concierge/tools";

/** A proposal's Change with no person: the exact object that must never disarm the check. */
const personlessAssign = { action: "assign_task", task_id: "task-1" };

describe("qa:TC missing SHO-2693 the required flag cannot be satisfied by the Change object", () => {
  it("qa:TC missing a Change in the flag position keeps the requirement on", () => {
    // The defect: this was undefined (falsy), so `if (!id)` answered "optional" for assign_task.
    expect(requiredPerson(personlessAssign)).toBe(true);
  });

  it("qa:TC missing only an explicit false asks for an optional person", () => {
    expect(requiredPerson(false)).toBe(false);
  });

  it("qa:TC missing a default and an explicit true are both required", () => {
    expect(requiredPerson()).toBe(true);
    expect(requiredPerson(undefined)).toBe(true);
    expect(requiredPerson(true)).toBe(true);
  });

  it("qa:TC missing no object disarms it, with or without a required key", () => {
    expect(requiredPerson({})).toBe(true);
    // Callers used to pass an options bag. It is not a flag: only the boolean `false` turns the requirement off.
    expect(requiredPerson({ required: false })).toBe(true);
  });

  // SHO-2693 independent re-verification (w52): the four shapes a caller could try in the flag position. Before the fix
  // the flag was `typeof o === "object" ? o.required : o`, so a nested `{ required: false }` answered false — optional —
  // and a personless assign_task became a card. Every one of these must keep the requirement on; only `false` may not.
  it("qa:TC missing a truthy non-boolean keeps the requirement on", () => {
    expect(requiredPerson(1)).toBe(true);
    expect(requiredPerson("true")).toBe(true);
    expect(requiredPerson([])).toBe(true); // truthy in JS, and the old code read it as an object with no key
  });

  it("qa:TC missing the string \"false\" keeps the requirement on", () => {
    // A model or a query string can carry "false". It is not the boolean, so it must not switch the check off.
    expect(requiredPerson("false")).toBe(true);
  });

  it("qa:TC missing a nested object keeps the requirement on at any depth", () => {
    expect(requiredPerson({ required: false })).toBe(true);
    expect(requiredPerson({ required: { value: false } })).toBe(true);
    expect(requiredPerson({ options: { required: false } })).toBe(true);
  });

  it("qa:TC missing an absent flag keeps the requirement on", () => {
    expect(requiredPerson()).toBe(true);
  });
});
