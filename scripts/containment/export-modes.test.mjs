// The exported artifact must satisfy its own preconditions.
//
// Why this file exists: the pinned tarball for 94cf6d9 shipped
// scripts/containment/lib/prod-marker-scan.sh at mode 0644, while slot9-optionR.sh:179 refuses to run
// unless `[ -x "$MARKER_SCAN" ]` succeeds. Every sha256 in MANIFEST.sha256 verified 5/5 and the root run
// still died at `REFUSING (partial=0): marker scanner missing`. File mode is not part of a sha256, so
// content integrity cannot catch a wrong mode - only a test that reads the export script and the guards
// together can. That is this test.
//
// It derives both requirements from source rather than restating them as constants:
//   1. which files the export ships (the FILES array in slot9-export.sh),
//   2. what mode the export gives each of them (its `chmod MODE <paths>` lines),
//   3. which of those files a shipped script exec-tests (`[ -x "$VAR" ]`, with $VAR resolved through its
//      own assignment in that script).
// A file that is exec-tested and not exported 0755 fails here instead of failing on the host.
//
// Runs under `node --test scripts/containment/*.test.mjs`; vitest.config.mts excludes scripts/**, so this
// deliberately does not import vitest.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const exportScript = readFileSync(path.join(root, "scripts/containment/slot9-export.sh"), "utf8");

/** Paths the export ships, from its FILES=( ... ) array. */
function shippedFiles() {
  const block = exportScript.match(/^FILES=\(\n([\s\S]*?)^\)/m);
  if (!block) throw new Error("slot9-export.sh has no FILES=( ... ) array");
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** path -> octal mode string ("755"/"644"), from the export's chmod lines. */
function exportedModes() {
  const modes = new Map();
  // The export wraps long chmod invocations over continuation lines, so join them before matching:
  // `chmod 0755 "a" \` + newline + `"b"` is one instruction, not two.
  const joined = exportScript.replace(/\\\n\s*/g, " ");
  for (const line of joined.split("\n")) {
    const match = line.match(/^\s*chmod\s+0?([0-7]{3})\s+(.*)$/);
    if (!match) continue;
    const [, mode, rest] = match;
    for (const literal of rest.matchAll(/"\$OUTDIR\/slot9\/([^"]+)"/g)) {
      modes.set(literal[1], mode);
    }
  }
  return modes;
}

describe("slot9 export modes", () => {
  const files = shippedFiles();
  const modes = exportedModes();

  it("ships at least the two entrypoints and both libs", () => {
    for (const required of [
      "scripts/containment/slot9-proof.sh",
      "scripts/containment/slot9-optionR.sh",
      "scripts/containment/lib/prod-marker-scan.sh",
      "scripts/containment/lib/unit-env-sources.sh",
    ]) {
      assert.ok(files.includes(required), `export does not ship ${required}`);
    }
  });

  it("sets an explicit mode for every file it ships, so none inherits the umask", () => {
    const unset = files.filter((f) => !modes.has(f));
    assert.deepEqual(unset, [], `shipped but never chmod'ed by the exporter: ${unset.join(", ")}`);
  });

  it("exports 0755 for every shipped file that a shipped script exec-tests with [ -x ]", () => {
    // Resolve `[ -x "$VAR" ]` to a path by finding VAR's own assignment inside the same shipped script.
    const offenders = [];
    for (const file of files) {
      if (!file.endsWith(".sh")) continue;
      const source = readFileSync(path.join(root, file), "utf8");
      for (const exec of source.matchAll(/\[\s+-x\s+"\$([A-Z_][A-Z0-9_]*)"\s+\]/g)) {
        const variable = exec[1];
        const assignment = source.match(
          new RegExp(`^readonly\\s+${variable}=.*?([A-Za-z0-9_.-]+\\.sh)`, "m"),
        );
        if (!assignment) continue;
        const target = files.find((f) => f.endsWith(`/${assignment[1]}`));
        if (!target) continue;
        if (modes.get(target) !== "755") offenders.push(`${target} (required -x by ${file}, exported ${modes.get(target) ?? "unset"})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `exec-tested by a shipped guard but not shipped executable: ${offenders.join(", ")}`,
    );
  });

  it("keeps the sourced lib non-executable, matching how it is invoked", () => {
    assert.equal(modes.get("scripts/containment/lib/unit-env-sources.sh"), "644");
  });
});
