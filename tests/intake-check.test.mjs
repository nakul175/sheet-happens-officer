import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RISK_LINE,
  expandChangedFiles,
  hasNoStorySpecReason,
  hasQaMarker,
  hasRiskLine,
  intakeProblems,
  isApiJobCovered,
  isTestOnly,
  isVitestConfig,
  isVitestTestFile,
  listChangedFiles,
  redact,
  sectionContainsHeadSha,
  selfCheckSection,
  storyExemption,
  storyIds,
  testTitles,
} from "../scripts/ci/intake-check.mjs";

const script = fileURLToPath(new URL("../scripts/ci/intake-check.mjs", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/intake.yml", import.meta.url), "utf8");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function passingBody(sha = HEAD) {
  return `Summary of the change.\n\nRisk: Low (CI-only, no runtime code)\n\n## Self-check\n\n${sha}\n`;
}

function problems(overrides) {
  return intakeProblems({
    title: "Update the board",
    body: passingBody(),
    headSha: HEAD,
    files: ["README.md"],
    readFile: () => null,
    ...overrides,
  });
}

describe("Risk line", () => {
  it("uses the intake Risk pattern", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain(String.raw`/^\s*\**Risk\**\s*:\s*\**(Low|Medium|High|Critical)\b/im`);
    expect(RISK_LINE.test("Risk: Low")).toBe(true);
  });

  it("accepts Low, Medium, High, and Critical, including markdown", () => {
    expect(hasRiskLine("Risk: Low")).toBe(true);
    expect(hasRiskLine("Risk: Low (CI-only, no runtime code)")).toBe(true);
    expect(hasRiskLine("  **Risk**: **Medium**")).toBe(true);
    expect(hasRiskLine("risk: high")).toBe(true);
    expect(hasRiskLine("Risk: Critical\n")).toBe(true);
  });

  it("rejects a missing, mistyped, or mid-sentence Risk line", () => {
    expect(hasRiskLine("")).toBe(false);
    expect(hasRiskLine("Risk: None")).toBe(false);
    expect(hasRiskLine("Risk: Lowest")).toBe(false);
    expect(hasRiskLine("See Risk: Low in the doc")).toBe(false);
    expect(problems({ body: "no risk\n\n## Self-check\n\n" + HEAD }).join("\n")).toMatch(/Missing Risk line/);
  });
});

describe("Self-check SHA", () => {
  it("reads the section through the next heading", () => {
    const body = "## Summary\n\nhello\n\n## Self-check\n\nabc\n\n## Later\n\nzzz\n";
    const section = selfCheckSection(body);
    expect(section).toContain("abc");
    expect(section).not.toContain("hello");
    expect(section).not.toContain("zzz");
    expect(selfCheckSection("Self-check: abcdefg\n\n## Next\n")).toContain("abcdefg");
    expect(selfCheckSection("**Self-check**\n\nabc\n")).toContain("abc");
    expect(selfCheckSection("no section")).toBe(null);
  });

  it("accepts the full SHA or a prefix of 7 or more characters", () => {
    expect(sectionContainsHeadSha(HEAD, HEAD)).toBe(true);
    expect(sectionContainsHeadSha(`head ${HEAD.slice(0, 7)} done`, HEAD)).toBe(true);
    expect(sectionContainsHeadSha(HEAD.slice(0, 12).toUpperCase(), HEAD)).toBe(true);
    expect(problems({ body: passingBody(HEAD.slice(0, 7)) })).toEqual([]);
  });

  it("rejects a short prefix, a non-prefix, and a SHA outside the section", () => {
    expect(sectionContainsHeadSha(HEAD.slice(0, 6), HEAD)).toBe(false);
    expect(sectionContainsHeadSha(HEAD.slice(1, 10), HEAD)).toBe(false);
    const outside = `Risk: Low\n\n${HEAD}\n\n## Self-check\n\nnot the sha\n`;
    expect(problems({ body: outside }).join("\n")).toMatch(/does not contain the head SHA/);
    expect(problems({ body: "Risk: Low\n" }).join("\n")).toMatch(/Missing Self-check section/);
  });
});

describe("story specs", () => {
  const spec = "tests/e2e/stories/APL-1234.spec.ts";

  it("takes APL ids from the title and from Refs lines", () => {
    expect(storyIds({ title: "Fix APL-12 and apl-34", body: "Refs APL-56\nAlso APL-78" })).toEqual([
      "APL-12",
      "APL-34",
      "APL-56",
    ]);
  });

  it("requires a matching spec whose test titles carry a qa:TC marker", () => {
    const files = ["src/app/(app)/page.tsx", spec];
    const readFile = (file) => {
      if (file !== spec) return null;
      return [
        'it("loads the board qa:TC-APL1234-1", () => {})',
        'test("empty state qa:TC missing", () => {})',
        'it.skip("retired qa:TC-9", () => {})',
      ].join("\n");
    };
    expect(problems({ title: "APL-1234 board", files, readFile })).toEqual([]);
    const broken = problems({
      title: "APL-1234 board",
      files,
      readFile: () => 'it("loads the board", () => {})\nit("other qa:TC-1", () => {})',
    });
    expect(broken).toEqual([
      `${spec}: test "loads the board" is missing a qa:TC marker (qa:TC-<id> or "qa:TC missing").`,
    ]);
  });

  it("reports a missing id and a missing spec as their own messages", () => {
    const ui = ["src/components/ui.tsx"];
    expect(problems({ title: "Polish the header", files: ui }).join("\n")).toMatch(/APL-xxxx id in the title/);
    const missing = problems({ title: "APL-1234 header", body: passingBody() + "\nRefs APL-5678\n", files: ui });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/Missing: tests\/e2e\/stories\/APL-1234\.spec\.ts, tests\/e2e\/stories\/APL-5678\.spec\.ts/);
  });

  it("accepts one matching spec when several ids are named", () => {
    const readFile = () => 'it("shown qa:TC-1", () => {})';
    expect(
      problems({
        title: "APL-1234",
        body: passingBody() + "\nRefs APL-5678\n",
        files: ["src/components/ui.tsx", spec],
        readFile,
      }),
    ).toEqual([]);
  });

  it("does not treat a deleted spec as included", () => {
    const found = problems({
      title: "APL-1234",
      files: [{ filename: spec, status: "removed" }, "src/app/(app)/page.tsx"],
      readFile: () => 'it("shown qa:TC-1", () => {})',
    });
    expect(found.join("\n")).toMatch(/Missing: tests\/e2e\/stories\/APL-1234\.spec\.ts/);
  });

  it("parses quoted titles and the two marker forms", () => {
    expect(testTitles('const it = 1\nit("alpha", () => {})\ntest(\'beta\', () => {})')).toEqual(["alpha", "beta"]);
    expect(hasQaMarker("case qa:TC-APL1-abc")).toBe(true);
    expect(hasQaMarker("case qa:TC missing today")).toBe(true);
    expect(hasQaMarker("case qa:TC")).toBe(false);
  });
});

describe("exemptions from the story spec", () => {
  const uiMessage = /story spec|APL-xxxx/;

  it("skips rule 3 for test-only changes and still checks Risk and Self-check", () => {
    expect(isTestOnly(["tests/board.test.ts", "vitest.config.mts", "vitest.e2e.config.mts"])).toBe(true);
    expect(isVitestConfig("vitest.crm-visible-modes.config.mts")).toBe(true);
    expect(isTestOnly(["tests/board.test.ts", "README.md"])).toBe(false);
    const files = ["tests/board.test.ts", "vitest.viewport.config.mts"];
    expect(storyExemption("No story spec is not this", files)).toBe("test-only");
    expect(problems({ body: "forgot both", files })).toEqual([
      'Missing Risk line. Add a body line such as "Risk: Low" (Low, Medium, High, or Critical).',
      "Missing Self-check section. Add a Self-check section that contains the current head SHA (the full SHA, or a prefix of at least 7 characters).",
    ]);
  });

  it("skips rule 3 for API or job changes that update a Vitest test", () => {
    const covered = ["src/app/api/health/route.ts", "src/lib/jobs.ts", "scripts/ci/task.mjs", "jobs/nightly.sh", "tests/health.test.ts"];
    expect(isApiJobCovered(covered)).toBe(true);
    expect(isVitestTestFile("tests/health.test.ts")).toBe(true);
    expect(isVitestTestFile("scripts/ci/task.test.mjs")).toBe(false);
    expect(problems({ files: covered })).toEqual([]);
    expect(problems({ files: ["src/lib/only.ts"] })).toEqual([]);
  });

  it("still requires a story spec for an API change with no Vitest test", () => {
    const files = ["src/app/api/health/route.ts"];
    expect(isApiJobCovered(files)).toBe(false);
    expect(storyExemption(passingBody(), files)).toBe(null);
    expect(problems({ title: "Health", files }).join("\n")).toMatch(uiMessage);
  });

  it("still requires a story spec when UI changes sit beside an API and a Vitest test", () => {
    const files = ["src/app/api/health/route.ts", "src/components/ui.tsx", "tests/health.test.ts"];
    expect(isApiJobCovered(files)).toBe(false);
    expect(problems({ title: "APL-9", files }).join("\n")).toMatch(/APL-9\.spec\.ts/);
  });

  it("honours an explicit No story spec reason and ignores a blank one", () => {
    expect(hasNoStorySpecReason("No story spec: API only, covered elsewhere")).toBe(true);
    expect(hasNoStorySpecReason("No story spec:")).toBe(false);
    expect(hasNoStorySpecReason("No story spec:   ")).toBe(false);
    expect(hasNoStorySpecReason("See No story spec: hidden")).toBe(false);
    const files = ["src/components/ui.tsx"];
    expect(storyExemption("Risk: Low\nNo story spec: copy change\n", files)).toBe("no-story-spec");
    expect(problems({ body: passingBody() + "\nNo story spec: copy change\n", files })).toEqual([]);
    expect(problems({ body: passingBody() + "\nNo story spec:\n", title: "APL-1", files }).join("\n")).toMatch(/APL-1\.spec\.ts/);
  });

  it("counts a renamed-away UI file", () => {
    const files = [{ filename: "src/lib/was-ui.ts", status: "renamed", previous_filename: "src/components/Was.tsx" }];
    expect(expandChangedFiles(files).map((file) => file.filename)).toEqual([
      "src/lib/was-ui.ts",
      "src/components/Was.tsx",
    ]);
    expect(problems({ title: "Move it", files }).join("\n")).toMatch(/APL-xxxx/);
  });
});

describe("workflow", () => {
  it("runs the intake job for the stated pull_request types and base branches", () => {
    expect(workflow).toMatch(/name: intake/);
    const on = workflow.slice(workflow.indexOf("on:\n"), workflow.indexOf("\npermissions:"));
    expect(on).toContain("pull_request:");
    expect(on).toContain("opened");
    expect(on).toContain("edited");
    expect(on).toContain("synchronize");
    expect(on).toContain("reopened");
    expect(on).toContain("main");
    expect(on).toContain("qa/story-e2e");
    expect(on).not.toContain("pull_request_target:");
    expect(on).not.toContain("push:");
  });

  it("keeps the default token read-only and does not print it", () => {
    const permissions = workflow.slice(workflow.indexOf("permissions:\n"), workflow.indexOf("\nconcurrency:"));
    expect(permissions).toContain("contents: read");
    expect(permissions).toContain("pull-requests: read");
    expect(permissions).not.toMatch(/write/);
    expect(workflow.match(/secrets\.[A-Za-z0-9_]+/g)).toEqual(["secrets.GITHUB_TOKEN"]);
    expect(workflow).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain("run: node scripts/ci/intake-check.mjs");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).not.toMatch(/echo\s+.*GITHUB_TOKEN/);
  });
});

describe("CLI", () => {
  const token = "ghs_intake_test_token_do_not_print";

  function listen(handler) {
    const server = createServer(handler);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function runCli(cwd, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("intake-check timed out"));
      }, 10000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  it("prints one message per missing item and never prints the token", async () => {
    const server = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ message: `bad ${token}` }));
        return;
      }
      if (url.pathname === "/repos/acme/taskboard/pulls/7/files") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ filename: "src/app/(app)/page.tsx", status: "modified" }]));
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "intake-cli-"));
      const eventPath = path.join(dir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: {
            number: 7,
            title: "Update the page",
            body: "No risk and no self-check.\n",
            head: { sha: HEAD },
            base: { ref: "main" },
          },
        }),
      );
      const result = await runCli(dir, {
        GITHUB_TOKEN: token,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "acme/taskboard",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(output).not.toContain(token);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::Missing Risk line");
      expect(result.stderr).toContain("::error::Missing Self-check section");
      expect(result.stderr).toContain("::error::UI changes require an APL-xxxx id");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("passes a pull request whose body names the head SHA and whose spec has markers", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({ filename: `src/lib/part-${index}.ts`, status: "modified" })),
      [{ filename: "tests/e2e/stories/APL-44.spec.ts", status: "added" }],
    ];
    let page = 0;
    const server = await listen((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end("no");
        return;
      }
      const batch = pages[page] ?? [];
      page += 1;
      if (batch.some((file) => file.filename.includes("stories"))) {
        batch.push({ filename: "src/components/ui.tsx", status: "modified" });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(batch));
    });
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "intake-ok-"));
      const specDir = path.join(dir, "tests", "e2e", "stories");
      mkdirSync(specDir, { recursive: true });
      writeFileSync(path.join(specDir, "APL-44.spec.ts"), 'it("renders qa:TC-APL44-1", () => {})\n');
      const eventPath = path.join(dir, "event.json");
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: {
            number: 44,
            title: "Notes",
            body: `${passingBody()}\nRefs APL-44\n`,
            head: { sha: HEAD },
          },
        }),
      );
      const result = await runCli(dir, {
        GITHUB_TOKEN: token,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "acme/taskboard",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(output).not.toContain(token);
      expect(result.status, output).toBe(0);
      expect(result.stdout).toContain("Intake check passed.");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("redacts the token when the API repeats it", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 500,
      text: async () => `leaked ${token} in the body`,
      json: async () => [],
    });
    await expect(
      listChangedFiles({
        apiUrl: "https://example.test",
        repository: "acme/taskboard",
        number: 1,
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(/\[redacted\]/);
    expect(redact(`leaked ${token}`, token)).toBe("leaked [redacted]");
  });
});
