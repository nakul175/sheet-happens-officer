// APL-2917. No test file reads the process image of environment variables, so no run can load every secret at once.
// This file names the banned path in its own examples, so the scan leaves out this one file. AC1 runs in base-url-env-2917.test.ts.
// No TC id is assigned on the issue.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SELF = path.join("tests", "no-proc-environ-2917.test.ts");
const ENVIRON = ["", "proc", "self", "environ"].join("/");
// Also any other spelling of the same file: /proc/<pid or ${...}>/environ, and a path joined at run time.
const PROC_ENVIRON = new RegExp(["/proc/", "[^\\s\"'`]*", "/environ\\b"].join(""));
const ENVIRON_PART = new RegExp(["[\"'`]environ", "[\"'`]"].join(""));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(c|m)?[jt]sx?$/.test(name)) out.push(full);
  }
  return out;
}

// "environ" as a path piece: after a quote, "/" or the "}" that closes a ${...}, and before a quote, "/" or "${".
// Catches a path built with `+`, ${...} or path.join, however the pieces are split ("/environ", 'environ',
// `${dir}environ`, "environ/..."). "environment" is not a match.
const ENVIRON_SEGMENT = /["'`/}]environ(?=["'`/$])/;
// The environ file exists only under /proc, so a lone environ piece counts only in a file that also names a proc
// path piece ("/proc", 'proc', `/proc/`). A "/environ" route or an 'environ' test title elsewhere is not flagged.
const PROC_SEGMENT = /["'`/]proc(?=["'`/$])/;

/** The test-file paths under tests/ whose source reads the process image of environment variables. */
export function environReaders(files: { file: string; text: string }[]) {
  return files
    .filter(({ text }) => text.includes(ENVIRON) || PROC_ENVIRON.test(text) || (PROC_SEGMENT.test(text) && (ENVIRON_PART.test(text) || ENVIRON_SEGMENT.test(text))))
    .map(({ file }) => file);
}

describe("qa:TC missing APL-2917: no test file reads the whole process environment", () => {
  it("qa:TC missing AC3: no file under tests/ reads the process environment image", () => {
    const files = filesUnder("tests").filter((file) => file !== SELF).map((file) => ({ file, text: readFileSync(file, "utf8") }));
    expect(files.length).toBeGreaterThan(50);
    expect(environReaders(files)).toEqual([]);
  });

  it("qa:TC missing AC3: the check catches each way of naming that file", () => {
    for (const text of [
      `readFileSync("${ENVIRON}")`,
      "readFileSync(`/proc/${process.pid}/environ`)",
      `readFileSync(path.join("/proc", "self", "environ"))`,
      `fs.readFileSync('/proc/1/environ', "latin1")`,
      // String concatenation (Pam, D1 on f263aad).
      `readFileSync("/proc/" + process.pid + "/environ")`,
      `readFileSync('/proc/self' + '/environ')`,
      "readFileSync(`/proc/${process.pid}` + `/environ`)",
      `const dir = "/proc/self/"; readFileSync(dir + "environ")`,
      // Template literals with the path split across pieces or inside ${...}.
      "readFileSync(`${\"/proc/self/\" + \"environ\"}`)",
      "readFileSync(`/proc/self/environ${suffix}`)",
      // A template that joins a directory variable to the file name (Pam, D1 on a935b24).
      'const dir = "/proc/self/"; readFileSync(`${dir}environ`)',
      'const procDir = "/proc/1/"; readFileSync(`${procDir}environ${suffix}`)',
      'const root = "/proc"; readFileSync(`${root}/${pid}/environ`)',
      "readFileSync(path.join(`/proc`, `self`, `environ`))",
    ]) {
      expect(environReaders([{ file: "x.ts", text }]), text).toEqual(["x.ts"]);
    }
    for (const text of [
      `readFileSync("/proc/self/stat")`,
      `const msg = "the environment is not read";`,
      "`${environment}/x`",
      `env.BASE_URL + "/environments"`,
      // No proc path piece in the file (Pam, D3 on a935b24): a route and a test title.
      `app.get("/environ", handler)`,
      `it('environ', () => {})`,
    ]) {
      expect(environReaders([{ file: "y.ts", text }]), text).toEqual([]);
    }
  });
});
