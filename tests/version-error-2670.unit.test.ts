// APL-2670 unit coverage: how a version value is classified, and the one body every version error uses.
import { describe, expect, it } from "vitest";
import {
  INVALID_VERSION, INVALID_VERSION_MESSAGE, NOT_FOUND, VERSION_CONFLICT, VERSION_CONFLICT_MESSAGE, VERSION_REQUIRED, VERSION_REQUIRED_MESSAGE,
  classifyVersionValue, isIsoTimestamp, isVersionCode, versionErrorBody, versionProblem,
} from "../src/lib/version-error";

describe("version classification (APL-2670)", () => {
  it("treats a missing body, a missing field and null as version_required", () => {
    expect(versionProblem(null)).toBe(VERSION_REQUIRED);
    expect(versionProblem(undefined)).toBe(VERSION_REQUIRED);
    expect(versionProblem([])).toBe(VERSION_REQUIRED);
    expect(versionProblem("3")).toBe(VERSION_REQUIRED);
    expect(versionProblem({})).toBe(VERSION_REQUIRED);
    expect(versionProblem({ title: "New" })).toBe(VERSION_REQUIRED);
    expect(versionProblem({ expectedUpdatedAt: null })).toBe(VERSION_REQUIRED);
    expect(versionProblem({ expectedUpdatedAt: undefined })).toBe(VERSION_REQUIRED);
    expect(classifyVersionValue(undefined)).toBe(VERSION_REQUIRED);
    expect(classifyVersionValue(null)).toBe(VERSION_REQUIRED);
  });

  it("treats an empty string and a non-ISO value as invalid_version, not missing", () => {
    expect(versionProblem({ expectedUpdatedAt: "" })).toBe(INVALID_VERSION);
    expect(versionProblem({ title: "New", expectedUpdatedAt: "" })).toBe(INVALID_VERSION);
    expect(versionProblem({ expectedUpdatedAt: "abc" })).toBe(INVALID_VERSION);
    expect(classifyVersionValue("")).toBe(INVALID_VERSION);
    expect(classifyVersionValue("abc")).toBe(INVALID_VERSION);
    expect(classifyVersionValue(" ")).toBe(INVALID_VERSION);
    expect(classifyVersionValue("2026-10-18")).toBe(INVALID_VERSION);
    expect(classifyVersionValue(3)).toBe(INVALID_VERSION);
    expect(isIsoTimestamp("abc")).toBe(false);
    expect(isIsoTimestamp("")).toBe(false);
  });

  it("accepts an ISO timestamp and does not invent an integer version", () => {
    const iso = "2026-10-18T00:00:00.000Z";
    expect(isIsoTimestamp(iso)).toBe(true);
    expect(versionProblem({ expectedUpdatedAt: iso })).toBeNull();
    expect(classifyVersionValue(new Date(iso).toISOString())).toBeNull();
  });
});

describe("version error body (APL-2670 AC3)", () => {
  it("is exactly { error: { code, message } } for each version code", () => {
    for (const [code, message] of [
      [VERSION_REQUIRED, VERSION_REQUIRED_MESSAGE],
      [INVALID_VERSION, INVALID_VERSION_MESSAGE],
      [VERSION_CONFLICT, VERSION_CONFLICT_MESSAGE],
    ] as const) {
      const body = versionErrorBody(code, message);
      expect(JSON.parse(JSON.stringify(body))).toEqual({ error: { code, message } });
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error)).toEqual(["code", "message"]);
    }
    const hidden = versionErrorBody(NOT_FOUND, "Task not found");
    expect(Object.keys(hidden)).toEqual(["error"]);
    expect(Object.keys(hidden.error)).toEqual(["code", "message"]);
    expect(hidden.error.code).toBe("not_found");
  });

  it("recognises only the three version codes", () => {
    expect(isVersionCode(VERSION_REQUIRED)).toBe(true);
    expect(isVersionCode(INVALID_VERSION)).toBe(true);
    expect(isVersionCode(VERSION_CONFLICT)).toBe(true);
    expect(isVersionCode("stale")).toBe(false);
    expect(isVersionCode(undefined)).toBe(false);
  });
});
