// SHO-2917 gap closure: SEC-2917-INDEPENDENT-MERGE.md §5, one describe per finding. F1 (a child process that prints its
// environment) and F2 (the module-level `env` routes) are VERIFIED here rather than taken from the hardening commit
// message: each route is written into a throwaway file on disk and read back through the one guard in
// base-url-no-environ-dump.test.ts, so the verdict rests on a real parse of a real file. F4 (raw BASE_URL in an error) and
// F5 (a directory symlink under tests/ is followed) are fixes with their own tests. F3 (indirection through a function
// parameter) is recorded as out of scope in execution/SEC-2917-GAPS.md.
// Nothing banned is written literally in this file: the process-image path and every route are assembled from parts at run
// time, so the AC1 tree scan can parse this file like any other and stay green.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scannedFiles, violations } from "./base-url-no-environ-dump.test";
import { filesUnder } from "./no-proc-environ-2917.test";
import { redactUserinfo } from "./e2e/base-url";

/** The process-image file, assembled so this file's own source never names it (the AC1 scan reads this file too). */
const IMAGE = `/${["pro", "c"].join("")}/self/${["envi", "ron"].join("")}`;
/** A read of that file, the one form every rotation of this guard has caught; used to prove a probe is non-vacuous. */
const BANNED_READ = `import { readFileSync } from "node:fs";\nreadFileSync(${JSON.stringify(IMAGE)}, "utf8");\n`;
const CLEAN = `export const target = process.env.TASKBOARD_URL;\n`;

const dirs: string[] = [];
/** A throwaway tree on disk: { "tests/x.test.ts": "<source>" } -> the root directory. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sho-2917-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
/** The violations the guard reports for a throwaway tree. */
function scan(dir: string) {
  return violations(scannedFiles(dir));
}
const reset = () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

describe("REVIEW-2917 F1: a child process that prints the whole environment is caught, as a real file on disk", () => {
  // Every route the hardening commit claimed, plus the absolute-path and VAR=VAL spellings of the same dump. Each file is
  // written and parsed on its own, so a route cannot pass by leaning on another.
  const ROUTES: [string, string][] = [
    ["execSync printenv", `execSync("printenv");`],
    ["spawnSync env", `spawnSync("env");`],
    ["execSync env pipe sort", `execSync("env | sort");`],
    ["spawnSync env stdio inherit", `spawnSync("env", [], { stdio: "inherit" });`],
    ["spawn sh -c env", `spawn("sh", ["-c", "env"]);`],
    ["spawnSync bash -c env pipe sort", `spawnSync("bash", ["-c", "env | sort"]);`],
    ["absolute path printenv", `execFileSync("/usr/bin/printenv", []);`],
    ["VAR=VAL prefix", `execSync("DEBUG=1 printenv");`],
    ["cp.execSync env", `cp.execSync("env");`],
  ];
  const HEAD = `import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";\nimport cp from "node:child_process";\n`;

  for (const [form, source] of ROUTES) {
    it(`qa:TC missing AC1: ${form} turns the guard RED in a file of its own`, () => {
      const found = scan(tree({ "tests/route.test.ts": `${HEAD}${source}\n` }));
      expect(found.map(({ form: hit }) => hit), source).toContain("environment printed by a child process");
      reset();
    });
  }

  it("qa:TC missing AC1: a child process that runs a normal command, or pins an env: allowlist, stays quiet", () => {
    const allowed = [
      `execSync("git rev-parse HEAD");`,
      `spawnSync("npm", ["run", "typecheck"], { encoding: "utf8" });`,
      // The explicit env: allowlist — the reason a child process is not banned outright.
      `spawnSync("npm", ["run", "typecheck"], { env: { ...process.env, CI: "1" } });`,
      `spawn(bin, args, { env: { ...process.env, PORT: "3191" } });`,
      // A shell running a script this file does not spell out.
      "const script = \"print\" + \"env\"; spawnSync(\"bash\", [\"-c\", script]);",
    ];
    for (const source of allowed) {
      const dir = tree({ "tests/allowed.test.ts": `${HEAD}const bin = "node"; const args: string[] = [];\n${source}\n` });
      expect(scan(dir).map(({ form: hit }) => hit), source).toEqual([]);
      reset();
    }
  });

  it("qa:TC missing AC1: the F1 probe is non-vacuous — the same harness reports a dump at process.env", () => {
    expect(scan(tree({ "tests/dump.test.ts": `console.log(process.env);\n` })).map(({ form: hit }) => hit)).toContain(
      "whole environment dumped",
    );
    reset();
  });
});

describe("REVIEW-2917 F2: the module-level env routes are caught, as a real file on disk", () => {
  const ROUTES: [string, string, string][] = [
    ["import env as e", `import { env as e } from "node:process";`, "whole environment imported"],
    ["import env", `import { env } from "node:process";`, "whole environment imported"],
    ["import env from process", `import { env as e } from "process";`, "whole environment imported"],
    ["destructure env from process", `const { env: e } = process;`, "whole environment destructured"],
    ["require node:process env", `void require("node:process").env;`, "whole environment accessed through require"],
  ];

  for (const [form, source, expected] of ROUTES) {
    it(`qa:TC missing AC1: ${form} turns the guard RED where it binds`, () => {
      // The binding itself is the violation: the whole object leaves `process` here, so no later `process.env` scan sees it.
      expect(scan(tree({ "tests/route.test.ts": `${source}\nvoid e;\n` })).map(({ form: hit }) => hit), source).toContain(expected);
      reset();
    });
  }

  it("qa:TC missing AC1: a destructured or imported env that is then dumped is still reported", () => {
    for (const source of [
      `import { env as e } from "node:process"; console.log(e);`,
      `const { env: e } = process; const request = { ...e }; void request;`,
      `void require("node:process").env;`,
    ]) {
      expect(scan(tree({ "tests/route.test.ts": `${source}\n` })).length, source).toBeGreaterThan(0);
      reset();
    }
  });

  it("qa:TC missing AC1: an `env` that is not the process environment stays quiet", () => {
    for (const source of [`import { env } from "./config";`, `const { env: serverEnv } = config;`, `const { env } = options;`]) {
      const dir = tree({ "tests/allowed.test.ts": `${source}\nvoid env; void serverEnv; void options;\n` });
      expect(scan(dir).map(({ form: hit }) => hit), source).toEqual([]);
      reset();
    }
  });
});

describe("REVIEW-2917 F4: a malformed BASE_URL is reported without its userinfo", () => {
  it("qa:TC missing AC2: redactUserinfo drops user:pass@ and keeps the rest of the target", () => {
    expect(redactUserinfo("https://user:sekret@host.test:9999/x")).toBe("https://<redacted>@host.test:9999/x");
    expect(redactUserinfo("//user:sekret@host.test/x")).toBe("//<redacted>@host.test/x");
    expect(redactUserinfo("user:sekret@host.test")).toBe("<redacted>@host.test");
    // A value with no userinfo is returned unchanged: staging and local targets still identify themselves.
    for (const value of ["http://localhost:3100", "https://staging.sheethappensofficer.com", "sheethappensofficer.aplyd.org"]) {
      expect(redactUserinfo(value)).toBe(value);
    }
  });

  it("qa:TC missing AC2: the import-time refusal of a malformed BASE_URL never echoes the userinfo", { timeout: 60_000 }, () => {
    const secret = "sekret-userinfo-2917";
    const value = `https://user:${secret}@not a url/2917`;
    const probe = `import(${JSON.stringify(`${process.cwd()}/tests/e2e/base-url.ts`)}).then(() => { console.log("IMPORTED"); }, (error) => { console.error(String(error)); });`;
    const run = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", probe], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 45_000,
      env: { ...process.env, VITEST: "", BASE_URL: value, SHO_E2E_START_BASE_URL: "", TASKBOARD_URL: "", STAGING_URL: "" },
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    expect(output, "the refusal did not run").toMatch(/BASE_URL is not a URL/);
    expect(output, "the userinfo reached the log").not.toContain(secret);
    expect(output).toContain("<redacted>@");
    expect(output, "the module loaded instead of refusing").not.toMatch(/IMPORTED/);
  });
});

describe("REVIEW-2917 F5: a directory symlink under the scan root is skipped, not traversed", () => {
  it("qa:TC missing AC3: filesUnder does not follow a directory symlink", () => {
    const outside = tree({ "leak.test.ts": BANNED_READ });
    const inside = tree({ "clean.test.ts": CLEAN });
    symlinkSync(outside, path.join(inside, "linked"), "dir");
    expect(filesUnder(inside), "the symlinked directory was traversed").toEqual([path.join(inside, "clean.test.ts")]);
    expect(scan(inside)).toEqual([]);
    // Non-vacuity: the file behind the link really is a violation, so the empty scan above is the skip, not a blind spot.
    expect(scan(outside).map(({ form: hit }) => hit), "a direct scan of the target must be RED").toContain("process image file read");
    reset();
  });

  it("qa:TC missing AC3: a symlinked file is skipped too, and real files beside it are still scanned", () => {
    const outside = tree({ "leak.test.ts": BANNED_READ });
    const inside = tree({ "clean.test.ts": CLEAN });
    symlinkSync(path.join(outside, "leak.test.ts"), path.join(inside, "linked.test.ts"));
    expect(filesUnder(inside)).toEqual([path.join(inside, "clean.test.ts")]);
    expect(readFileSync(path.join(inside, "clean.test.ts"), "utf8")).toBe(CLEAN);
    reset();
  });
});


