// W240 (QA test hygiene): the write-path guard.
//
// The rule: A TEST MUST NOT WRITE WHERE ANOTHER TEST CAN READ.
//
// Two incidents in this pool came from exactly that — a shared `EMAIL_OUTBOX_DIR` (W115, fixed by
// SHO-2897 and guarded in tests/outbox-collision-2897.test.ts) and a shared database schema
// (W121/W140/W159/W168/W193/W200). Both were found by hand. This file is the mechanical half: it
// answers, for every filesystem write a test performs, whether the target is derived from a per-run
// temp dir (`mkdtemp`/`tmpdir`) or is a fixed path that a second file also resolves.
//
// A fixed path is not automatically a defect — screenshot evidence has to land where a human looks
// for it after a red run. The defect is a path with MORE THAN ONE WRITING FILE, because then either
// run can observe the other's bytes, and a stale file from a previous run can satisfy an assertion
// that this run's write never satisfied. So the guard does not ban fixed paths; it pins each one to
// the single file that owns it. A new shared path is red, and so is a new ownerless directory.
//
// Pure functions only: the caller reads the sources (see test-write-hygiene.test.ts), so the
// positive controls can feed a synthetic file that does not exist on disk.

export type Source = { path: string; source: string };

export type Origin = "temp" | "repo-fixed" | "unrooted";

export type WriteSite = {
  file: string;
  line: number;
  /** the target expression as written, before binding expansion */
  target: string;
  /** the expression after `const NAME = ...` expansion */
  resolved: string;
  origin: Origin;
  /** `test-results/<segment>`, lowercased (macOS is case-insensitive), when origin is repo-fixed */
  dir: string | null;
};

/** Calls that create or modify a file or directory. `rm*` is cleanup, not a write, and is excluded:
 *  a test deleting its own evidence cannot make another test's assertion pass. */
const WRITE_CALL =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|createWriteStream|copyFileSync|cpSync|symlinkSync|renameSync)\s*\(/g;

/** These take (source, destination): the path that gets written is the SECOND argument. Reading the
 *  first would report `cpSync(TESTS_DIR, tempDir)` as a write to the repo's tests/ directory. */
const TWO_ARG = /^(?:copyFileSync|cpSync|symlinkSync|renameSync)$/;

/** Playwright writes evidence through an API, not through node:fs: `page.screenshot({ path: X })`.
 *  Without this arm the whole browser tier is invisible to the guard. */
const SHOT_CALL = /\.screenshot\s*\(\s*\{[^}]*?\bpath\s*:\s*/g;

const DECL = /^[ \t]*(?:(?:const|let|var)[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(.+?);?[ \t]*$/;

/** Drop `//` line comments and block comments. A path named in prose is not a writer: the tier
 *  guard (tests/tier-placement.test.ts) shipped once parsing commented-out entries as live ones. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:*\\])\/\/[^\n]*/g, (_, lead: string) => lead);
}

/** The text of one call argument / property value, starting at `from`, to the first `,` or `)` at
 *  depth 0. Good enough for the shapes tests actually write; it does not try to be a parser. */
function argumentAt(text: string, from: number, index = 0): string {
  let depth = 0;
  let out = "";
  let seen = 0;
  for (let i = from; i < text.length && i - from < 240; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      if (seen === index) break;
      seen += 1;
      out = "";
      continue;
    }
    if (ch === "\n") break;
    if (seen === index) out += ch;
  }
  return out.trim();
}

/** `const NAME = <expr>` expansion, transitively (a dir is usually named in one const and then
 *  joined in another). Three hops covers `const cache = join(cwd,'node_modules','.cache')` followed
 *  by `const dir = mkdtempSync(join(cache, ...))`. */
function expand(target: string, bindings: Map<string, string>): string {
  let text = target;
  for (let hop = 0; hop < 3; hop += 1) {
    let changed = false;
    for (const [name, rhs] of bindings) {
      if (new RegExp(`\\b${name}\\b`).test(text) && !text.includes(rhs)) {
        text = `${text} ${rhs}`;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return text;
}

/** `test-results/viewport`, from any of the spellings in the tree:
 *  `"test-results/a11y"`, `path.join(ROOT, "test-results/viewport")`,
 *  `path.join("test-results", "apl-2733")`, and `"test-results/a11y/TC-1.txt"` (a file inside it,
 *  which shares the directory with a writer of the directory itself). */
function testResultsDir(text: string): string | null {
  const match = /test-results(?:[\\/"'\s]*,[ \t]*[\\"']?|[\\/"']+)([A-Za-z0-9._-]+)/.exec(text);
  if (match) return `test-results/${match[1].toLowerCase()}`;
  if (/test-results/.test(text)) return "test-results";
  return null;
}

function classify(target: string, resolved: string): { origin: Origin; dir: string | null } {
  // A per-run temp dir wins over everything: mkdtemp gives every call its own name.
  if (/mkdtemp/.test(resolved) || /\btmpdir\s*\(/.test(resolved)) return { origin: "temp", dir: null };
  const dir = testResultsDir(resolved);
  if (dir) return { origin: "repo-fixed", dir };
  return { origin: "unrooted", dir: null };
}

/** Every filesystem write in every source, with where it goes and whether that is per-run. */
export function writeSites(sources: Source[]): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const { path: file, source } of sources) {
    const text = stripComments(source);
    const bindings = new Map<string, string>();
    for (const line of text.split("\n")) {
      const decl = DECL.exec(line);
      if (decl) bindings.set(decl[1], decl[2]);
    }
    const lineStarts = [0];
    for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (index: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };

    for (const call of [...text.matchAll(WRITE_CALL), ...text.matchAll(SHOT_CALL)]) {
      // For (source, destination) calls the destination is the second argument.
      const index = TWO_ARG.test(call[1] ?? "") ? 1 : 0;
      const target = argumentAt(text, (call.index ?? 0) + call[0].length, index);
      if (!target) continue;
      const resolved = expand(target, bindings);
      sites.push({ file, line: lineOf(call.index ?? 0), target, resolved, ...classify(target, resolved) });
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export type SharedDir = { dir: string; files: string[]; expected: string[] };

/** Directories whose writer set differs from the recorded one. A shared DIRECTORY is legitimate —
 *  `.github/workflows/viewport.yml` and phone-checks.yml upload `test-results/viewport/` after a
 *  failure, so the suites that produce those screenshots have to write into that one folder. What is
 *  not legitimate is a writer nobody recorded: a second file quietly resolving a folder another file
 *  owns, or a brand-new folder with no owner at all. Both are what this returns. */
export function sharedDirs(sites: WriteSite[], owned: Record<string, string[]>): SharedDir[] {
  const byDir = new Map<string, Set<string>>();
  for (const site of sites) {
    if (!site.dir) continue;
    if (!byDir.has(site.dir)) byDir.set(site.dir, new Set());
    byDir.get(site.dir)!.add(site.file);
  }
  const offenders: SharedDir[] = [];
  for (const [dir, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const seen = [...files].sort();
    const expected = (owned[dir] ?? []).slice().sort();
    if (seen.length !== expected.length || seen.some((file, i) => file !== expected[i])) {
      offenders.push({ dir, files: seen, expected });
    }
  }
  return offenders;
}

/** Writes whose root the guard cannot prove is per-run: not mkdtemp, not under test-results. */
export function unrooted(sites: WriteSite[]): WriteSite[] {
  return sites.filter((site) => site.origin === "unrooted");
}
