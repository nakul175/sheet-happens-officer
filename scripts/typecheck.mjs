// Runs next typegen, then tsc --noEmit, without leaving files outside .next.
// next typegen writes next-env.d.ts at the repo root; tsc needs that file while it
// runs, and the original bytes (or its absence) are restored afterwards.
// The incremental cache goes to .next/cache so it is not a root tsconfig.tsbuildinfo.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextEnv = path.join(root, "next-env.d.ts");
const hadNextEnv = existsSync(nextEnv);
const previousNextEnv = hadNextEnv ? readFileSync(nextEnv) : null;

function restoreNextEnv() {
  const present = existsSync(nextEnv);
  if (!hadNextEnv) {
    if (present) rmSync(nextEnv);
    return;
  }
  const current = present ? readFileSync(nextEnv) : null;
  if (!current || !current.equals(previousNextEnv)) writeFileSync(nextEnv, previousNextEnv);
}

function run(name, args) {
  const result = spawnSync(path.join(root, "node_modules", ".bin", name), args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let status = 1;
try {
  status = run("next", ["typegen"]);
  if (status === 0) {
    mkdirSync(path.join(root, ".next", "cache"), { recursive: true });
    status = run("tsc", ["--noEmit", "--tsBuildInfoFile", ".next/cache/tsconfig.tsbuildinfo"]);
  }
} finally {
  restoreNextEnv();
}

process.exit(status);
