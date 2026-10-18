// APL-2676: one npm script type-checks the project (next typegen, then tsc --noEmit).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPECHECK = "next typegen && tsc --noEmit";

// A fresh clone has dependencies installed (node_modules from postinstall) and none of the
// generated or local-only trees. .next is the folder the scenario says must be absent.
const SKIP_TOP = new Set(["node_modules", ".next", ".git", ".outbox", ".outbox-ci", "coverage", "test-results", "out", "build"]);

// next typegen writes route types and next-env.d.ts. tsc --noEmit with incremental writes a
// cache. Neither is a production build (no .next/server, .next/static, or emitted JavaScript).
const ALLOWED_NEW = new Set(["next-env.d.ts", "tsconfig.tsbuildinfo"]);

function freshClone(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-typecheck-"));
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
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

function runTypecheck(cwd: string) {
  const result = spawnSync("npm", ["run", "typecheck"], { cwd, encoding: "utf8", env: process.env, timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, error: result.error };
}

function listFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else out.push(path.relative(root, full));
  }
  return out;
}

/** Paths written by the script that are not typegen output or the tsc incremental cache. */
function buildOutputWritten(dir: string, before: Set<string>): string[] {
  return listFiles(dir).filter((rel) => {
    if (before.has(rel) || ALLOWED_NEW.has(rel)) return false;
    if (rel === ".next/types" || rel.startsWith(`.next${path.sep}types${path.sep}`)) return false;
    return true;
  });
}

describe("One command type-checks the project", () => {
  it("Typecheck from a clean checkout", () => {
    const dir = freshClone();
    try {
      expect(existsSync(path.join(dir, "node_modules", "typescript")), "dependencies installed").toBe(true);
      expect(existsSync(path.join(dir, "node_modules", "next")), "dependencies installed").toBe(true);
      expect(existsSync(path.join(dir, ".next")), "no .next folder").toBe(false);

      const script = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.typecheck as string;
      expect(script).toBe(TYPECHECK);
      expect(script.indexOf("tsc --noEmit")).toBeGreaterThan(script.indexOf("next typegen"));

      const result = runTypecheck(dir);
      expect(result.error, result.output).toBeUndefined();
      expect(result.output).toContain(TYPECHECK);
      expect(result.output).toContain("Generating route types...");
      expect(result.output).toContain("Types generated successfully");
      expect(existsSync(path.join(dir, ".next", "types", "routes.d.ts")), "next typegen wrote route types").toBe(true);
      const typesMtime = statSync(path.join(dir, ".next", "types", "routes.d.ts")).mtimeMs;
      const tscInfo = path.join(dir, "tsconfig.tsbuildinfo");
      expect(existsSync(tscInfo), "tsc --noEmit ran").toBe(true);
      expect(statSync(tscInfo).mtimeMs).toBeGreaterThanOrEqual(typesMtime);
      expect(result.status, result.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("A type error fails the script", () => {
    const dir = freshClone();
    try {
      const rel = path.join("src", "deliberate-type-error.ts");
      writeFileSync(path.join(dir, rel), 'export const count: number = "not-a-number";\n');
      const before = new Set(listFiles(dir));

      const result = runTypecheck(dir);
      expect(result.error, result.output).toBeUndefined();
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("src/deliberate-type-error.ts(1,");
      expect(buildOutputWritten(dir, before)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
