// APL-2676 v1.1: one command type-checks the project, including in CI.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPECHECK = "next typegen && tsc --noEmit";

const SKIP_TOP = new Set(["node_modules", ".next", ".git", ".outbox", ".outbox-ci", "coverage", "test-results", "out", "build"]);

function freshClone(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-typecheck-"));
  cpProject(dir);
  return dir;
}

function cpProject(dir: string) {
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (SKIP_TOP.has(top)) return false;
      if (top.startsWith(".env") && top !== ".env.example") return false;
      if (rel.endsWith(".tsbuildinfo")) return false;
      return true;
    },
  });
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Link the npm ci install, and record whether the tsc bin actually starts. */
function linkDependencies(dir: string, traceFile: string) {
  const real = path.join(ROOT, "node_modules");
  const dest = path.join(dir, "node_modules");
  mkdirSync(path.join(dest, ".bin"), { recursive: true });
  for (const name of readdirSync(real, { encoding: "utf8" })) {
    if (name === ".bin") continue;
    symlinkSync(path.join(real, name), path.join(dest, name));
  }
  const realBin = path.join(real, ".bin");
  for (const name of readdirSync(realBin, { encoding: "utf8" })) {
    const from = path.join(realBin, name);
    const to = path.join(dest, ".bin", name);
    if (name === "tsc") {
      writeFileSync(to, `#!/bin/sh\nprintf '%s\\n' tsc >> ${quoteSh(traceFile)}\nexec ${quoteSh(from)} "$@"\n`);
      chmodSync(to, 0o755);
    } else {
      symlinkSync(from, to);
    }
  }
}

function prepare(dir: string): string {
  const trace = path.join(tmpdir(), `sho-tsc-${path.basename(dir)}`);
  rmSync(trace, { force: true });
  linkDependencies(dir, trace);
  return trace;
}

function cleanup(dir: string, trace: string) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(trace, { force: true });
}

function readTrace(trace: string): string[] {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, "utf8").split("\n").filter(Boolean);
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-c", "user.email=typecheck-test@example.com", "-c", "user.name=typecheck-test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout ?? "";
}

function baseline(dir: string) {
  git(dir, ["init"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "baseline"]);
}

/** Porcelain paths that are not inside .next. Empty means nothing changed outside .next. */
function changesOutsideNext(dir: string): string[] {
  return git(dir, ["status", "--porcelain"]).split("\n").filter((line) => {
    if (!line.trim()) return false;
    const file = line.slice(3);
    return file !== ".next" && !file.startsWith(".next/");
  });
}

function runTypecheck(cwd: string) {
  const result = spawnSync("npm", ["run", "typecheck"], { cwd, encoding: "utf8", env: process.env, timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, error: result.error };
}

function scriptOf(dir: string): string {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.typecheck as string;
}

describe("One command type-checks the project, in CI", () => {
  it("Typecheck from a clean checkout", () => {
    const dir = freshClone();
    const trace = prepare(dir);
    try {
      expect(existsSync(path.join(dir, "node_modules", "typescript")), "npm ci dependencies installed").toBe(true);
      expect(existsSync(path.join(dir, "node_modules", "next")), "npm ci dependencies installed").toBe(true);
      expect(existsSync(path.join(dir, "package-lock.json"))).toBe(true);
      expect(existsSync(path.join(dir, ".next")), "no .next folder").toBe(false);

      const script = scriptOf(dir);
      expect(script).toBe(TYPECHECK);
      expect(script.indexOf("tsc --noEmit")).toBeGreaterThan(script.indexOf("next typegen"));
      baseline(dir);

      const first = runTypecheck(dir);
      expect(first.error, first.output).toBeUndefined();
      expect(first.status, first.output).toBe(0);
      const routes = path.join(dir, ".next", "types", "routes.d.ts");
      expect(existsSync(routes), "next typegen wrote into .next").toBe(true);
      expect(readTrace(trace), "tsc ran").toEqual(["tsc"]);
      expect(statSync(trace).mtimeMs).toBeGreaterThanOrEqual(statSync(routes).mtimeMs);
      expect(changesOutsideNext(dir), "git status is clean outside .next").toEqual([]);

      expect(existsSync(path.join(dir, ".next")), ".next present for the second run").toBe(true);
      const second = runTypecheck(dir);
      expect(second.error, second.output).toBeUndefined();
      expect(second.status, second.output).toBe(0);
      expect(readTrace(trace)).toEqual(["tsc", "tsc"]);
      expect(changesOutsideNext(dir), "git status is clean outside .next").toEqual([]);
    } finally {
      cleanup(dir, trace);
    }
  }, 180_000);

  it("A type error fails the script and writes nothing outside .next", () => {
    const dir = freshClone();
    const trace = prepare(dir);
    try {
      const rel = path.join("src", "zz-test-type-error.ts");
      writeFileSync(path.join(dir, rel), 'const n: number = "x";\n');
      baseline(dir);

      const result = runTypecheck(dir);
      expect(result.error, result.output).toBeUndefined();
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/zz-test-type-error\.ts(?:\(|:)1\b/);
      expect(existsSync(path.join(dir, ".next", "types", "routes.d.ts")), "typegen may write into .next").toBe(true);
      expect(changesOutsideNext(dir), "git status is clean outside .next").toEqual([]);
      expect(existsSync(path.join(dir, "dist"))).toBe(false);
      expect(existsSync(path.join(dir, "src", "zz-test-type-error.js"))).toBe(false);
      expect(readTrace(trace)).toEqual(["tsc"]);
    } finally {
      cleanup(dir, trace);
    }
  }, 120_000);

  // TC-APL2676-8399450a@v1 · Typegen failure stops the script before tsc
  // Pre: clean clone; break next config in a scratch copy.
  // Expected: npm run typecheck exits non-zero and tsc does not run.
  it("A typegen failure stops the script before tsc (TC-APL2676-8399450a@v1)", () => {
    const dir = freshClone();
    const trace = prepare(dir);
    try {
      writeFileSync(path.join(dir, "next.config.ts"), 'throw new Error("broken next config");\n');
      const result = runTypecheck(dir);
      expect(result.error, result.output).toBeUndefined();
      expect(result.status, result.output).not.toBe(0);
      expect(readTrace(trace), "tsc does not run").toEqual([]);
    } finally {
      cleanup(dir, trace);
    }
  }, 60_000);

  it("Typecheck runs in CI on every pull request", () => {
    const workflowPath = path.join(ROOT, ".github", "workflows", "typecheck.yml");
    const yaml = readFileSync(workflowPath, "utf8");
    expect(yaml).toMatch(/pull_request:[\s\S]*branches:\s*\[main\]/);
    expect(yaml).toMatch(/npm run typecheck/);
    expect(yaml).not.toMatch(/continue-on-error:\s*true/);
    expect(yaml).not.toMatch(/\n\s*push:/);
    for (const banned of ["deploy.yml", "phone-checks.yml", "staging-e2e.yml"]) {
      expect(readFileSync(path.join(ROOT, ".github", "workflows", banned), "utf8")).not.toContain("npm run typecheck");
    }
  });
});
