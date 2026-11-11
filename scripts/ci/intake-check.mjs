// Pull request intake check. Rules are documented at the top of
// .github/workflows/intake.yml and in the README "Pull request intake" section.
//
// Reads the pull request title, body, and head SHA from the GitHub event, and
// the changed files from the GitHub API, using the default GITHUB_TOKEN.
// The token is never printed. Story spec files are read from the working tree
// (the workflow checks out the head SHA).

import { readFileSync } from "node:fs";
import { join, normalize as normalizePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Body line required on every pull request. */
export const RISK_LINE = /^\s*\**Risk\**\s*:\s*\**(Low|Medium|High|Critical)\b/im;

const ACTIVE_CHANGE = new Set(["added", "modified", "renamed", "copied", "changed"]);

export function redact(text, token) {
  const value = String(text ?? "");
  if (!token) return value;
  return value.split(token).join("[redacted]");
}

export function hasRiskLine(body) {
  return RISK_LINE.test(String(body ?? ""));
}

export function normalizeRepoPath(filename) {
  return String(filename ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function asFile(entry) {
  if (typeof entry === "string") return { filename: entry, status: "modified" };
  if (!entry || typeof entry !== "object") return null;
  return entry;
}

/** One record per current path, plus the previous path of a rename. */
export function expandChangedFiles(files) {
  const out = [];
  for (const entry of files ?? []) {
    const file = asFile(entry);
    if (!file) continue;
    const status = file.status ?? "modified";
    const filename = normalizeRepoPath(file.filename);
    if (filename) out.push({ filename, status, previous_filename: file.previous_filename });
    const previous = normalizeRepoPath(file.previous_filename);
    if (previous && previous !== filename) out.push({ filename: previous, status: "removed" });
  }
  return out;
}

export function isVitestConfig(filename) {
  return /(?:^|\/)vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s$/.test(normalizeRepoPath(filename));
}

/** A Vitest test file. scripts/ keeps node:test files, which are not Vitest. */
export function isVitestTestFile(filename) {
  const name = normalizeRepoPath(filename);
  if (name.startsWith("scripts/")) return false;
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name);
}

export function isTestOnlyPath(filename) {
  const name = normalizeRepoPath(filename);
  return name.startsWith("tests/") || isVitestConfig(name);
}

export function isNonTestFile(filename) {
  const name = normalizeRepoPath(filename);
  if (name.startsWith("tests/")) return false;
  if (isVitestTestFile(name)) return false;
  return true;
}

export function isApiJobPath(filename) {
  const name = normalizeRepoPath(filename);
  return (
    name.startsWith("src/app/api/") ||
    name.startsWith("src/lib/") ||
    name.startsWith("scripts/") ||
    name === "jobs" ||
    name.startsWith("jobs/")
  );
}

/**
 * UI for rule 3. src/app/** includes API routes; an API/job pull request that
 * also changes a Vitest test is exempt in storyExemption.
 */
export function isUiPath(filename) {
  const name = normalizeRepoPath(filename);
  return name.startsWith("src/app/") || name.startsWith("src/components/");
}

export function isAddedOrChanged(file) {
  const status = file?.status ?? "modified";
  return ACTIVE_CHANGE.has(status);
}

export function isTestOnly(files) {
  const list = expandChangedFiles(files);
  if (list.length === 0) return false;
  return list.every((file) => isTestOnlyPath(file.filename));
}

/** API/lib/scripts/jobs changes that also add or change a Vitest test. */
export function isApiJobCovered(files) {
  const list = expandChangedFiles(files);
  if (list.length === 0) return false;
  const nonTest = list.filter((file) => isNonTestFile(file.filename));
  if (!nonTest.every((file) => isApiJobPath(file.filename))) return false;
  return list.some((file) => isVitestTestFile(file.filename) && isAddedOrChanged(file));
}

/** Explicit waiver. The reason after the colon must be non-empty. */
export function hasNoStorySpecReason(body) {
  return /^\s*No story spec:\s*\S/im.test(String(body ?? ""));
}

/**
 * Why rule 3 does not apply, or null when the story spec is still required
 * for a UI change. Rules 1 and 2 are not affected.
 */
export function storyExemption(body, files) {
  if (hasNoStorySpecReason(body)) return "no-story-spec";
  if (isTestOnly(files)) return "test-only";
  if (isApiJobCovered(files)) return "api-job";
  return null;
}

/**
 * The Self-check section: a heading, a "Self-check:" line, or a bold label,
 * through the next heading.
 */
export function selfCheckSection(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  let start = -1;
  let first = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*$/);
    if (heading && /^self-check\b/i.test(heading[2].replace(/[*_]/g, "").trim())) {
      start = i;
      first = heading[2].replace(/^(?:\*\*|__)?self-check(?:\*\*|__)?\s*:?\s*/i, "");
      break;
    }
    const labeled = line.match(/^\s*(?:\*\*|__)?self-check(?:\*\*|__)?\s*:\s*(.*)$/i);
    if (labeled) {
      start = i;
      first = labeled[1];
      break;
    }
    if (/^\s*(?:\*\*|__)?self-check(?:\*\*|__)?\s*$/i.test(line)) {
      start = i;
      first = "";
      break;
    }
  }
  if (start < 0) return null;
  const chunks = [first];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*#{1,6}\s+\S/.test(lines[i])) break;
    if (/^\s*(?:\*\*|__)(?!\s*self-check\b)[^*_\n]+(?:\*\*|__)\s*$/i.test(lines[i])) break;
    chunks.push(lines[i]);
  }
  return chunks.join("\n");
}

/** Full head SHA, or a prefix of at least 7 characters. */
export function sectionContainsHeadSha(section, headSha) {
  const head = String(headSha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(head)) return false;
  const tokens = String(section ?? "").toLowerCase().match(/[0-9a-f]{7,64}/g) ?? [];
  return tokens.some((token) => token.length >= 7 && token.length <= head.length && head.startsWith(token));
}

export function selfCheckProblem(body, headSha) {
  const head = String(headSha ?? "").trim();
  const section = selfCheckSection(body);
  if (section === null) {
    return "Missing Self-check section. Add a Self-check section that contains the current head SHA (the full SHA, or a prefix of at least 7 characters).";
  }
  if (!head) {
    return "Missing head SHA. The Self-check section must contain the current head SHA.";
  }
  if (!sectionContainsHeadSha(section, head)) {
    return `Self-check section does not contain the head SHA ${head}. Include the full SHA or a prefix of at least 7 characters.`;
  }
  return null;
}

/** APL ids from the title, and from body lines that say "Refs APL-xxxx". */
export function storyIds({ title, body }) {
  const ids = new Set();
  for (const match of String(title ?? "").matchAll(/\bAPL-(\d+)\b/gi)) ids.add(`APL-${match[1]}`);
  for (const match of String(body ?? "").matchAll(/\bRefs\s+APL-(\d+)\b/gi)) ids.add(`APL-${match[1]}`);
  return [...ids];
}

export function storySpecPath(id) {
  return `tests/e2e/stories/${id}.spec.ts`;
}

/** String titles of it(...) and test(...) calls, including it.skip / test.only. */
export function testTitles(source) {
  const titles = [];
  const re = /(?:^|[^\w.])(?:it|test)(?:\.(?:only|skip|todo|concurrent|fails))?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const match of String(source ?? "").matchAll(re)) {
    titles.push(decodeTitle(match[2], match[1]));
  }
  return titles;
}

function decodeTitle(value, quote) {
  if (quote === "`") return value;
  return value.replace(/\\(["'`\\])/g, "$1");
}

export function hasQaMarker(title) {
  return title.includes("qa:TC missing") || /qa:TC-\S+/.test(title);
}

function includedStorySpecs(files, ids) {
  const wanted = new Map(ids.map((id) => [storySpecPath(id), id]));
  const found = [];
  for (const file of expandChangedFiles(files)) {
    const id = wanted.get(file.filename);
    if (!id || !isAddedOrChanged(file)) continue;
    if (!found.some((item) => item.path === file.filename)) found.push({ id, path: file.filename });
  }
  return found;
}

function storySpecProblems({ title, body, files, readFile }) {
  const ids = storyIds({ title, body });
  if (ids.length === 0) {
    return [
      'UI changes require an APL-xxxx id in the title or a "Refs APL-xxxx" line in the body, and tests/e2e/stories/APL-xxxx.spec.ts in the pull request.',
    ];
  }
  const specs = includedStorySpecs(files, ids);
  if (specs.length === 0) {
    const expected = ids.map((id) => storySpecPath(id)).join(", ");
    return [
      `UI changes require a story spec matching an APL id from the title or a Refs line. Missing: ${expected}.`,
    ];
  }
  const problems = [];
  for (const spec of specs) {
    const source = readFile(spec.path);
    if (source == null) {
      problems.push(`Could not read ${spec.path}.`);
      continue;
    }
    for (const testTitle of testTitles(source)) {
      if (hasQaMarker(testTitle)) continue;
      const shown = testTitle.length > 120 ? `${testTitle.slice(0, 117)}...` : testTitle;
      problems.push(
        `${spec.path}: test "${shown}" is missing a qa:TC marker (qa:TC-<id> or "qa:TC missing").`,
      );
    }
  }
  return problems;
}

/**
 * One message per missing item. Empty means the pull request passes.
 * @param {{ title?: string, body?: string, headSha?: string, files?: unknown[], readFile: (path: string) => string | null }} input
 */
export function intakeProblems({ title = "", body = "", headSha = "", files = [], readFile }) {
  const problems = [];
  if (!hasRiskLine(body)) {
    problems.push('Missing Risk line. Add a body line such as "Risk: Low" (Low, Medium, High, or Critical).');
  }
  const shaProblem = selfCheckProblem(body, headSha);
  if (shaProblem) problems.push(shaProblem);
  if (!storyExemption(body, files) && expandChangedFiles(files).some((file) => isUiPath(file.filename))) {
    problems.push(...storySpecProblems({ title, body, files, readFile }));
  }
  return problems;
}

export function readWorkspaceFile(root, filename) {
  const relative = normalizeRepoPath(filename);
  if (!relative || relative.split("/").includes("..")) return null;
  const full = normalizePath(join(root, relative));
  const base = normalizePath(root + sep);
  if (full !== normalizePath(root) && !full.startsWith(base)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

export async function listChangedFiles({ apiUrl, repository, number, token, fetchImpl = fetch }) {
  const root = String(apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const url = `${root}/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "intake-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const detail = redact(await response.text(), token).slice(0, 300);
      throw new Error(`GitHub API returned ${response.status} listing pull request files. ${detail}`.trim());
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("GitHub API returned an unexpected file list.");
    for (const file of data) {
      if (!file || typeof file.filename !== "string") continue;
      files.push({
        filename: file.filename,
        status: file.status ?? "modified",
        previous_filename: file.previous_filename,
      });
    }
    if (data.length < 100) break;
  }
  return files;
}

function fail(token, message) {
  console.error(`::error::${redact(message, token)}`);
  process.exit(1);
}

async function main() {
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!token) fail("", "GITHUB_TOKEN is not set.");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) fail(token, "GITHUB_EVENT_PATH is not set.");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) fail(token, "GITHUB_REPOSITORY is not set.");

  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    fail(token, `Could not read the GitHub event (${error instanceof Error ? error.message : String(error)}).`);
  }
  const pull = event?.pull_request;
  if (!pull || pull.number == null) fail(token, "This event has no pull request.");

  let files;
  try {
    files = await listChangedFiles({
      apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
      repository,
      number: pull.number,
      token,
    });
  } catch (error) {
    fail(token, error instanceof Error ? error.message : String(error));
  }

  const problems = intakeProblems({
    title: pull.title ?? "",
    body: pull.body ?? "",
    headSha: pull.head?.sha ?? "",
    files,
    readFile: (filename) => readWorkspaceFile(process.cwd(), filename),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${redact(problem, token)}`);
    process.exit(1);
  }
  console.log("Intake check passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
