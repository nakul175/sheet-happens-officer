// APL-2736 follow-up: the test environment contract must be complete and self-consistent.
//
// Why this file exists: the v4-v10 harness fix cycles failed because the documented `npm test`
// env prefix and the README purpose table drifted apart, and because vitest.config.mts has NO
// setupFiles. That absence is the reason an unset variable surfaced as wholesale import failures
// (a module read process.env.DATABASE_URL at import time and threw) instead of the suite skipping
// the database-backed files. Both facts are easy to regress silently, so they are asserted here.
//
// This file is pure file parsing: no live server, no database, no child process. It is fast and
// hermetic on purpose, so it can run anywhere `npm test` runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Variables the `npm test` command line must set for the vitest process (README contract). */
const REQUIRED = ["DATABASE_URL", "JOB_SECRET", "TASKBOARD_URL", "EMAIL_OUTBOX_DIR", "SUPER_ADMIN_EMAILS"] as const;

function testSection(readme: string): string {
  const start = readme.indexOf("\n## Test\n");
  if (start < 0) throw new Error("README has no Test section");
  const rest = readme.slice(start + 1);
  const next = rest.slice("## Test\n".length).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + "## Test\n".length);
}

function bashBlock(section: string): string {
  const block = section.match(/```bash\n([\s\S]*?)```/);
  if (!block) throw new Error("Test section has no bash block");
  return block[1];
}

/** Leading KEY=value pairs, then the command. Quotes are kept out of the value. */
function splitEnv(command: string): { env: Record<string, string>; rest: string } {
  const env: Record<string, string> = {};
  let rest = command.trim();
  for (;;) {
    const match = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*/);
    if (!match) break;
    env[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    rest = rest.slice(match[0].length);
  }
  return { env, rest };
}

function commands(section: string): { env: Record<string, string>; rest: string }[] {
  return bashBlock(section)
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s*&\s*$/, ""))
    .filter(Boolean)
    .map(splitEnv);
}

function purposes(section: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of section.split("\n")) {
    const row = line.match(/^\|\s*`([A-Z0-9_]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (row) found[row[1]] = row[2];
  }
  return found;
}

function npmTestEnv(section: string): Record<string, string> {
  const command = commands(section).find((item) => item.rest === "npm test");
  if (!command) throw new Error('Test section has no "npm test" command');
  return command.env;
}

/** The dev server the Test section starts, the one `TASKBOARD_URL` points at. */
function devServer(section: string): { env: Record<string, string>; rest: string } {
  const server = commands(section).find((item) => /next dev/.test(item.rest));
  if (!server) throw new Error("Test section has no dev server command");
  return server;
}

const readme = readFileSync("README.md", "utf8");
const section = testSection(readme);

describe("test env contract: README npm test line + vitest config", () => {
  it("the npm test command sets every variable the suite needs", () => {
    const env = npmTestEnv(section);
    // Removing DATABASE_URL or JOB_SECRET from this line is the exact regression that broke the
    // harness: several files open the database and call the job endpoint from the test process.
    for (const name of REQUIRED) {
      expect(env[name], `${name} on the npm test command line`).toBeTruthy();
    }
  });

  it("every variable on the npm test line is documented in the README purpose table", () => {
    const table = purposes(section);
    for (const name of REQUIRED) {
      expect(table[name], `${name} row in the README purpose table`).toBeTruthy();
    }
  });

  it("the purpose table documents no variable the npm test line does not set", () => {
    // The other direction: a row for a variable nobody exports is stale documentation.
    const env = npmTestEnv(section);
    for (const name of Object.keys(purposes(section))) {
      expect(env[name], `${name} is in the purpose table but not on the npm test line`).toBeTruthy();
    }
  });

  it("vitest.config.mts still has no setupFiles", () => {
    // Deliberate: with no setupFiles there is no shared place to fail fast on a missing variable,
    // so an unset DATABASE_URL/JOB_SECRET throws at import time and takes whole files down instead
    // of letting the DB-backed ones skip. If someone adds setupFiles, this contract must be
    // re-documented (README ## Test) and this assertion updated in the same change.
    const config = readFileSync("vitest.config.mts", "utf8");
    expect(config).not.toMatch(/\bsetupFiles\b/);
  });

  it("TASKBOARD_URL points the suite at the server the README starts", () => {
    const env = npmTestEnv(section);
    const server = commands(section).find((item) => /next dev/.test(item.rest));
    expect(server, "Test section starts a dev server").toBeTruthy();
    const port = server!.env.APP_URL?.match(/:(\d+)\b/)?.[1];
    expect(port, "APP_URL port in the server command").toBeTruthy();
    expect(env.TASKBOARD_URL).toBe(server!.env.APP_URL);
  });
});

// APL-2652 follow-up. tests/return-to.test.ts reads `process.env.SERVER_LOG ?? "server.log"` and requires a
// `[return-path] …` line for each v16 probe. src/proxy.ts writes those lines only when the SERVER has
// RETURN_PATH_LOG=1. Documenting the variable (as the prose above the table does) is not enough: the dev-server
// line the README publishes never set it, so the probe had nothing to read and the check could only pass in CI.
describe("return-path probe: the documented dev server can write what the test reads", () => {
  it("the dev server the README starts sets RETURN_PATH_LOG=1", () => {
    expect(devServer(section).env.RETURN_PATH_LOG, "RETURN_PATH_LOG=1 on the dev server line").toBe("1");
  });

  it("the dev server writes the log the probe reads (server.log)", () => {
    // Unset SERVER_LOG means the test reads ./server.log, so the documented server has to write that file.
    expect(devServer(section).rest, "the dev server line redirects to server.log").toMatch(/>\s*server\.log\b/);
  });

  it("npm run dev sets it too, so a plain dev server answers the same probe", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev, "RETURN_PATH_LOG=1 in the dev script").toMatch(/(^|\s)RETURN_PATH_LOG=1\s+next dev/);
  });

  it("the proxy still gates the line on RETURN_PATH_LOG=1 and the test still reads server.log", () => {
    // The other end of the contract. Without these two the assertions above would prove a variable nobody uses.
    const proxy = readFileSync("src/proxy.ts", "utf8");
    expect(proxy, "proxy gated on RETURN_PATH_LOG === \"1\"").toContain('process.env.RETURN_PATH_LOG === "1"');
    expect(proxy, "proxy writes the [return-path] line").toContain("[return-path]");
    expect(readFileSync("tests/return-to.test.ts", "utf8"), "the test reads SERVER_LOG, else server.log")
      .toContain('process.env.SERVER_LOG ?? "server.log"');
    // ...and only counts what the running server appended while it ran, so a log left by an earlier run cannot let a
    // server with RETURN_PATH_LOG unset pass (SHO-3024).
    expect(readFileSync("tests/return-to.test.ts", "utf8"), "the probe counts only bytes appended during the test")
      .toContain("logSizeAtStart");
  });

  // SHO-3024. This used to name ci.yml alone, so deploy.yml — the release gate, which runs the same `npm test` tier on
  // every push to main — kept starting `next start` without the variable and could not pass the return-path probe. The
  // check is over every workflow that runs the tier now, so a new one (or a rename) cannot miss it either.
  it("every workflow that runs npm test starts the server under test the same way", () => {
    // W311, SHO-3024 residual. This filter used to be one flat regex, /^\s*-?\s*run:\s*npm test\s*$/m, so a workflow
    // that wrote the same tier as `run: |` + `npm test`, as `npm run test`, with a trailing pipe or with a KEY=value
    // prefix was invisible to the guard that is supposed to catch a third runner. workflowsRunningNpmTest() reads the
    // YAML and then the shell instead (see the parser at the end of this file); it also refuses the two prose mentions
    // of `npm test` in staging-e2e.yml, which a word-grep would have counted as a runner.
    const files = workflowsRunningNpmTest();
    expect(files, "the scan finds the workflows that run the tier").toEqual(
      expect.arrayContaining([".github/workflows/ci.yml", ".github/workflows/deploy.yml"]),
    );
    for (const file of files) {
      expect(readFileSync(file, "utf8"), `${file} sets RETURN_PATH_LOG=1 for the server under test`)
        .toMatch(/RETURN_PATH_LOG=1\s+npx next start/);
    }
  });

  // W311. The other half of that widening: staging-e2e.yml mentions `npm test` twice and runs it zero times — once in
  // a `#` comment inside a `run: |` block (:130) and once inside the `echo "::error::…"` string beside it (:155). Both
  // are prose about the tier, not a runner of it. A scan that widened by grepping for the words would pull this
  // workflow into the set above and demand a `next start` line it has no business having, so the negative is pinned
  // here rather than left to the reader of a green run.
  it("staging-e2e.yml is not a runner: its npm test mentions are a comment and an echo", () => {
    expect(workflowsRunningNpmTest(), "a prose mention of npm test is not an invocation")
      .not.toContain(".github/workflows/staging-e2e.yml");
    // …and the file still contains those mentions, so the assertion above is not green because they were deleted.
    expect(readFileSync(".github/workflows/staging-e2e.yml", "utf8"), "the prose this refuses is still in the file")
      .toMatch(/^\s*#.*npm test/m);
    expect(readFileSync(".github/workflows/staging-e2e.yml", "utf8"), "the echo this refuses is still in the file")
      .toMatch(/echo "[^"\n]*npm test[^"\n]*"/);
  });

  // The shapes the flat regex skipped, as fixtures. A new workflow can be written in any of them tomorrow; these say
  // the scan would still count it, which the two real runners cannot say because neither uses these shapes today.
  it("the scan counts every shape a workflow can write the invocation in", () => {
    const step = (body: string) => `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${body}`;
    const shapes: Record<string, string> = {
      "single line (`- run: npm test`)": "      - run: npm test\n",
      "literal block (`run: |`)": "      - run: |\n          npx prisma migrate deploy\n          npm test\n",
      "folded block (`run: >`)": "      - run: >\n          npm test\n",
      "long form (`npm run test`)": "      - run: npm run test\n",
      "trailing pipe (`npm test | tee …`)": "      - run: npm test | tee vitest.log\n",
      "env prefix (`KEY=value npm test`)":
        "      - run: DATABASE_URL=postgresql://nobody@localhost:5432/t JOB_SECRET=0123456789abcdef npm test\n",
    };
    const missed = Object.entries(shapes).filter(([, body]) => !runsTier(step(body))).map(([name]) => name);
    expect(missed, "shapes the scan still cannot see").toEqual([]);
    // The reader locates the step's key, not the line the word happens to be on, so a failure can name the step.
    const block = step("      - run: |\n          echo hi\n          npm test\n");
    expect(runScripts(block).map((run) => run.line), "the YAML key line of the run step").toEqual([5]);
  });

  // The widening must not turn into a word-grep: a workflow only runs the tier if a shell would start `npm test` there.
  it("the scan refuses prose and sibling npm scripts", () => {
    const step = (body: string) => `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${body}`;
    const notInvocations: Record<string, string> = {
      "a shell comment inside a run block": "      - run: |\n          # npm test covers this elsewhere\n          echo hi\n",
      "an echoed string": "      - run: |\n          echo \"::error::npm test runs them; Playwright ignores them\"\n",
      "a different npm script": "      - run: npm run test:browser\n",
      "a step name": "      - name: npm test\n        run: echo hi\n",
      "a YAML comment above a step": "      # - run: npm test\n      - run: echo hi\n",
    };
    const counted = Object.entries(notInvocations).filter(([, body]) => runsTier(step(body))).map(([name]) => name);
    expect(counted, "prose or another script counted as a runner of the tier").toEqual([]);
  });
});

// W248. The APL-2652 D9 AC2 case (tests/return-to.test.ts:803-817) waits until it runs to find out that the server was
// started without a log, so the runner learns about it after the whole database tier. The precondition is cheap to state:
// SERVER_LOG is a claim the runner makes about a file the *server* writes. When it is set, the file has to be there. When
// it is unset the documented default is ./server.log in the repo root, which an offline run may legitimately not have —
// the server creates it at redirect time, long before any test reads it — so the guard stays quiet then (reported as
// skipped, not as a silent pass) and CI, which starts `next start > server.log` without SERVER_LOG, is unaffected.
const SERVER_LOG = process.env.SERVER_LOG;

describe("SERVER_LOG, when the runner sets it, names the log the server writes", () => {
  it.skipIf(!SERVER_LOG)("the file SERVER_LOG names exists before tests/return-to.test.ts reads it", () => {
    expect(
      existsSync(SERVER_LOG!),
      `SERVER_LOG=${SERVER_LOG} does not exist. tests/return-to.test.ts reads the running server's own log from `
        + `process.env.SERVER_LOG ?? "server.log" and fails at :803 without it. Start the server so its output goes to `
        + `that file, with RETURN_PATH_LOG=1 on the SERVER process: `
        + `RETURN_PATH_LOG=1 npx next dev -p 3100 > ${SERVER_LOG} 2>&1 & `
        + `(README ## Test, "What the tests read from the server, not from the test process").`,
    ).toBe(true);
  });

  it("the README publishes that server line, so the runner can copy it", () => {
    // The requirement only counts if it is written where a runner starts a server. This is the W248 section of README
    // ## Test; without it the state is "known to two reports", which is how the same failure was diagnosed twice.
    // testSection() cuts the section at the next "\n## ", so the new subsection runs to the end of the string it returns.
    const written = (section.match(/### What the tests read from the server[\s\S]*/) ?? [""])[0];
    expect(written, "README ## Test has the section naming what the tests read from the server").not.toBe("");
    const prose = written.replace(/\\\n/g, " "); // a shell line continuation is one command
    expect(prose, "the server line sets RETURN_PATH_LOG=1 on the server process").toContain("RETURN_PATH_LOG=1");
    expect(prose, "the server line sends its output to the file the test reads").toContain("npx next dev -p 3100 > server.log 2>&1");
    expect(prose, "the section names SERVER_LOG as the test-side pointer to that file").toContain("SERVER_LOG");
    // The quote is wrapped in the prose, so compare with the wrapping taken out.
    expect(written.replace(/\s+/g, " "), "the section quotes the failure a log-less server produces")
      .toContain("the server under test appended no [return-path] line");
  });
});

// SHO-US-19.1 (APL-2590), W202. tests/comments-19-1.test.ts has two halves: cases that call the library in this
// process, and cases named "flag off" that describe what the SERVER does. commentsEnabled() reads the environment of
// the process it runs in (src/lib/flags.ts:12) and AC9 says no request field may change the server's copy, so a
// flag-off case means nothing against a server started with FF_TASK_COMMENTS on: it would report PASSED for a claim
// it never exercised, which is the same lie as a green test that asserts nothing. W190 gave those cases a
// `requireFlagOffServer(ctx)` guard that skips with the printed reason instead. This keeps the guard from being
// dropped from a new case: an unguarded one fails here by name.
describe("comments-19-1: every flag-off case owns the flag it asserts", () => {
  it("each case in a `flag off` describe calls requireFlagOffServer", () => {
    const src = readFileSync("tests/comments-19-1.test.ts", "utf8");
    const unguarded: string[] = [];
    // One chunk per top-level describe block: the name is the first string in it, the cases are the lines indented
    // exactly two spaces (nested describes would need a parser, and this file has none inside a flag-off block).
    for (const block of src.split(/^describe\(/m).slice(1)) {
      const name = block.match(/^"([^"]+)"/)?.[1] ?? "";
      if (!/flag off/i.test(name)) continue;
      for (const part of block.split(/^  it\(/m).slice(1)) {
        const title = part.match(/^"([^"]+)"/)?.[1] ?? "";
        if (!part.includes("requireFlagOffServer(")) unguarded.push(title);
      }
    }
    expect(unguarded, "flag-off cases that never ask for a server whose flag is off").toEqual([]);
  });

  it("the guard skips with the reason on record, not silently", () => {
    const src = readFileSync("tests/comments-19-1.test.ts", "utf8");
    // ctx.skip(note) is what prints the reason; ctx.skip() with no note is the silent form this rules out.
    expect(src, "requireFlagOffServer passes a note to ctx.skip").toMatch(/async function requireFlagOffServer\(ctx: TestContext\) \{\s*if \(await serverCommentsOn\(\)\) ctx\.skip\(SERVER_FLAG_ON_NOTE\);/);
    expect(src, "the note names the flag it could not control").toContain("was started with FF_TASK_COMMENTS on");
  });
});

// ---- SHO-3024 residual (W311): which workflows run the tier ------------------------------------------------------
//
// The guard above began as one flat regex, /^\s*-?\s*run:\s*npm test\s*$/m. It saw the two runners of the day and
// would have missed the same tier written four other ways — a `run: |` block, `npm run test`, a trailing pipe, or a
// leading KEY=value — which is exactly the "a third runner cannot miss it either" the ticket asks for, unmet. The
// opposite mistake is just as easy: `npm test` also appears twice in staging-e2e.yml as prose (a `#` comment and an
// echoed ::error:: string), and a word-grep would count that workflow as a runner and demand a log line it should not
// have. So the text is read the way YAML and then the shell read it, in that order: which scalar belongs to which
// `run:` key, then where a shell would actually start a command.
//
// What this does not model, and does not need to: heredocs (no workflow here uses one in a run block), a `run:` written
// as a flow mapping or as an anchor/alias, and command prefixes other than KEY=value (`if npm test`, `time npm test`).
// A workflow written that way would still be invisible — the honest statement of the widening, not a claim of parsers.

type RunScript = { line: number; script: string };

/** A YAML block-scalar header: `|`, `|-`, `|+`, `>`, `>+`, and the optional indent indicator (`|2`). */
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

/**
 * Every `run:` value in a workflow file, with the line number of its key. The body of one step's block scalar is
 * consumed as content, so a workflow that prints workflow YAML (or a `run:`-shaped comment inside a script) cannot
 * make this see a step that is not there.
 */
function runScripts(yaml: string): RunScript[] {
  const lines = yaml.split("\n");
  const found: RunScript[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].match(/^(\s*)(?:-\s+)?run:[ \t]*(.*)$/);
    if (!key) continue;
    const keyIndent = key[1].length;
    const header = key[2].replace(/\s+#.*$/, "").trim(); // a YAML comment after the scalar on the key line
    if (!BLOCK_SCALAR.test(header)) {
      const inline = header.replace(/^(['"])([\s\S]*)\1$/, "$2");
      if (inline !== "") found.push({ line: i + 1, script: inline });
      continue;
    }
    // Block scalar: the lines below it that are indented further than the key, dedented by their own common indent.
    const body: string[] = [];
    let indent = Number.POSITIVE_INFINITY;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") { body.push(""); continue; }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= keyIndent) break;
      indent = Math.min(indent, lineIndent);
      body.push(line);
    }
    const keyLine = i + 1;
    i = j - 1;
    const dedented = body.map((line) => (line.trim() === "" ? "" : line.slice(indent)));
    // `>` folds adjacent lines into one and turns a blank line into a newline; `|` keeps every line as written.
    found.push({ line: keyLine, script: header.startsWith(">") ? foldScalar(dedented) : dedented.join("\n") });
  }
  return found;
}

/** YAML `>` folding, to the extent a shell line needs it: neighbours join with a space, a blank line stays a newline. */
function foldScalar(lines: string[]): string {
  let folded = "";
  for (const line of lines) {
    if (line.trim() === "") folded += "\n";
    else folded += folded === "" || folded.endsWith("\n") ? line : ` ${line}`;
  }
  return folded;
}

/**
 * The simple commands a shell script can start, as the shell splits them: `#` runs to the end of the line outside
 * quotes, a quoted `;` or `|` separates nothing, a trailing `\` continues the line, and `; & | ( ) < >` each end a
 * command. Only the start of each command matters here: that is what tells an invocation from a mention of one.
 */
function shellCommands(script: string): string[] {
  const found: string[] = [];
  let command = "";
  let quote: '"' | "'" | null = null;
  const end = () => {
    if (command.trim() !== "") found.push(command.trim());
    command = "";
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      command += ch;
      if (ch === "\\" && quote === '"') command += script[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; command += ch; continue; }
    if (ch === "\\") {
      const next = script[++i];
      command += next === "\n" || next === undefined ? " " : next;
      continue;
    }
    if (ch === "#" && (command === "" || /\s$/.test(command))) {
      const eol = script.indexOf("\n", i);
      i = eol < 0 ? script.length : eol - 1; // the loop's i++ lands on the newline, which ends the command
      continue;
    }
    if ("\n;&|()<>".includes(ch)) { end(); continue; }
    command += ch;
  }
  end();
  return found;
}

/** The KEY=value assignments a workflow can put in front of the command on the same line. */
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/** `npm test`, and its long form `npm run test` — but not `npm run test:browser`, which is a different tier. */
const NPM_TEST = /^npm\s+(?:run\s+)?test(?=$|\s)/;

/** True when a `run:` script really starts the tier, whichever shape the step is written in. */
function runsNpmTest(script: string): boolean {
  return shellCommands(script).some((command) => NPM_TEST.test(command.replace(ENV_PREFIX, "")));
}

/** True when a workflow file (YAML text) has a step that really starts the tier. */
function runsTier(yaml: string): boolean {
  return runScripts(yaml).some((run) => runsNpmTest(run.script));
}

/** The workflows that run the tier, i.e. the ones the RETURN_PATH_LOG contract above applies to. */
function workflowsRunningNpmTest(): string[] {
  return readdirSync(".github/workflows")
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
    .filter((file) => runsTier(readFileSync(file, "utf8")));
}
