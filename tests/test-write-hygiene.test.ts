// W240: the mechanical half of test hygiene — a test must not write where another test can read.
//
// tests/outbox-collision-2897.test.ts guards the one shared path that already bit this pool (.outbox,
// W115). This file guards the rest, by inventory: it reads every source under tests/, extracts every
// filesystem write, and fails when a write resolves a `test-results` directory a file it does not
// expect also writes — or a directory nobody has recorded at all.
//
// The recorded map is the allowlist, and it is deliberately a set of files per directory rather than
// one owner: test-results/viewport/ must stay one folder because two CI workflows upload it, but the
// three files that write there are named explicitly. Adding a fourth writer is a red run.
//
// No database, no server, no network: it reads .ts files off disk.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sharedDirs, unrooted, writeSites, type Source } from "./test-write-hygiene";

const ROOT = process.cwd();
const TESTS = path.join(ROOT, "tests");

/** Every source under tests/. `recursive` keeps this honest as folders are added. This test's own
 *  file is skipped: it holds synthetic write strings as positive controls, and scanning them would
 *  report the controls as violations. */
function sources(): Source[] {
  return (readdirSync(TESTS, { recursive: true }) as string[])
    .filter((name) => /\.(?:ts|tsx|mts|cjs|js|mjs)$/.test(name) && !name.includes("node_modules"))
    .filter((name) => name.split(path.sep).join("/") !== "test-write-hygiene.test.ts")
    // tests/eval/runner.ts is `npm run eval:concierge`, a CLI that writes a report to $OUT and to
    // $GITHUB_STEP_SUMMARY. It is not collected by any vitest tier, so it is not a test write.
    .filter((name) => !name.split(path.sep).join("/").startsWith("eval/"))
    .map((name) => ({
      path: `tests/${name.split(path.sep).join("/")}`,
      source: readFileSync(path.join(TESTS, name), "utf8"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Every file recorded as writing a `test-results` directory. A directory with more than one entry is
 *  shared on purpose; the comment says why, so a reviewer can tell a design from an accident. */
const RECORDED: Record<string, string[]> = {
  // Uploaded as the `viewport-screenshots` artifact by viewport.yml:92 and phone-checks.yml:82, so the
  // producers share the folder. Distinct file names: `<screen>-<width>.png` and `phone-*.png`.
  "test-results/viewport": ["tests/viewport/viewport.test.ts", "tests/viewport/comments-phone.test.ts"],
  // W240 moved tests/useGet-path-reset.test.ts out of this folder: a jsdom unit test writing evidence
  // into the folder the browser tier's a11y suite owns.
  "test-results/a11y": ["tests/viewport/a11y.test.ts"],
  // One story/local spec per folder, each writing only its own screenshots. Keys are lowercased
  // because the guard lowercases: macOS is case-insensitive, so `apl-2742` and `APL-2742` are one
  // folder and the guard must not let that difference hide a collision.
  "test-results/apl-2559": ["tests/e2e/stories/APL-2559.spec.ts"],
  "test-results/apl-2694": ["tests/e2e/stories/APL-2694.spec.ts"],
  "test-results/apl-2728": ["tests/e2e/local/APL-2728.test.ts"],
  "test-results/apl-2733": ["tests/e2e/stories/APL-2733.spec.ts"],
  "test-results/apl-2735": ["tests/e2e/stories/APL-2735.spec.ts"],
  "test-results/apl-2739": ["tests/e2e/local/APL-2739.test.ts"],
  "test-results/apl-2742": ["tests/e2e/stories/APL-2742.spec.ts"],
  "test-results/useget-path-reset": ["tests/useGet-path-reset.test.ts"],
};

/** Writes whose target the scanner cannot trace to a root, each with the reason it is safe. This is
 *  the honest half of the guard: a text scanner cannot follow a value through a function parameter,
 *  so instead of pretending, every unresolved site is named here. A NEW one is a red run. */
const SCANNER_BLIND =
  "per-run by hand: the value comes from an mkdtemp(dir) or a mkdtemp child (dest/inside/d/out/helper " +
  "parameter). A text scanner keeps one binding per NAME per file and cannot see scopes, so it loses " +
  "the local that shadows another function's `dir`. Verified by reading the file, not assumed.";

const UNRESOLVED: Record<string, string> = {
  "tests/owned-outbox-app.test.ts:17":
    "Embedded child-server source writes only EMAIL_OUTBOX_DIR, supplied by the runner from this test's mkdtemp root; the real subprocess test verifies that exact private destination and cleans it.",
  "tests/e2e/stories/APL-2651.spec.ts:314":
    "opt-in debug dump to $SHAPE_OUT, written only when that variable is set. An env-named fixed path, " +
    "so two runs setting the same value collide; recorded, not fixed, because it is a debugging aid.",
  "tests/readme-test-env.test.ts:88":
    "mkdirSync of node_modules/.cache, a shared cache PARENT; the probe tree inside it is mkdtemp.",
  "tests/typecheck.test.ts:21": SCANNER_BLIND,
  "tests/typecheck.test.ts:43": SCANNER_BLIND,
  "tests/typecheck.test.ts:46": SCANNER_BLIND,
  "tests/typecheck.test.ts:53": SCANNER_BLIND,
  "tests/typecheck.test.ts:56": SCANNER_BLIND,
  "tests/typecheck.test.ts:169": SCANNER_BLIND,
  "tests/typecheck.test.ts:197": SCANNER_BLIND,
  "tests/sec-2917-gaps.test.ts:30": SCANNER_BLIND,
  "tests/sec-2917-gaps.test.ts:31": SCANNER_BLIND,
  "tests/sec-2917-gaps.test.ts:161": SCANNER_BLIND,
  "tests/sec-2917-gaps.test.ts:172": SCANNER_BLIND,
  "tests/staging-e2e-seed.test.ts:39": SCANNER_BLIND,
};


describe("W240 test write hygiene: no test writes where another test can read", () => {
  it("inventories the writes in tests/ (not vacuously empty)", () => {
    const sites = writeSites(sources());
    const temp = sites.filter((site) => site.origin === "temp");
    const fixed = sites.filter((site) => site.origin === "repo-fixed");
    // A scanner that silently matched nothing would make every assertion below pass. The floors are
    // from the W240 sweep: 74 sites, most of them mkdtemp-derived, a dozen under test-results/.
    expect(sites.length, `write sites found in tests/ (${sites.length})`).toBeGreaterThan(50);
    expect(temp.length, `mkdtemp-derived write sites (${temp.length})`).toBeGreaterThan(20);
    expect(fixed.length, `test-results write sites (${fixed.length})`).toBeGreaterThan(5);
  });

  it("every test-results directory has exactly the writers recorded for it", () => {
    const offenders = sharedDirs(writeSites(sources()), RECORDED);
    const report = offenders
      .map((o) => `${o.dir}\n  wrote:    ${o.files.join(", ") || "(none)"}\n  recorded: ${o.expected.join(", ") || "(none)"}`)
      .join("\n");
    expect(
      report,
      "a test writes a folder with a different set of writers than W240 recorded. If the sharing is " +
        "deliberate (a CI artifact path), add the file to RECORDED in this test; if it is accidental, " +
        "give the test its own folder or an mkdtemp dir.",
    ).toBe("");
  });

  it("no test writes outside both test-results/ and a per-run temp dir", () => {
    const sites = unrooted(writeSites(sources()));
    const found = sites.map((site) => `${site.file}:${site.line}`);
    expect(found.sort(), "a write the guard cannot trace to mkdtemp or to a recorded test-results path; " +
      "either derive it (mkdtemp) or add it to UNRESOLVED with the reason it is safe").toEqual(
      Object.keys(UNRESOLVED).sort(),
    );
    expect(found.length, "unresolved writes are a recorded, finite set").toBeLessThan(20);
  });

  it("the APL-2559 screenshot assertion still proves this run wrote the file", () => {
    // existsSync + a size floor is satisfied by a PNG a previous run left behind. The spec deletes its
    // target before the screenshot; dropping that rmSync silently reopens the hole, so it is pinned.
    const spec = readFileSync(path.join(TESTS, "e2e/stories/APL-2559.spec.ts"), "utf8");
    expect(spec, "APL-2559 removes the stale target before asserting it exists").toMatch(
      /rmSync\(shot,\s*\{\s*force:\s*true\s*\}\)/,
    );
    expect(spec, "APL-2559 writes into its own folder, not the viewport suite's").toContain(
      '"test-results/APL-2559"',
    );
  });

  it("the guard bites: a new shared path and a new folder are both red, mkdtemp is not", () => {
    const ok: Record<string, string[]> = { "test-results/ok": ["tests/a.test.ts"] };
    const clean = writeSites([
      {
        path: "tests/a.test.ts",
        source:
          'import { mkdtempSync } from "node:fs";\nconst dir = mkdtempSync("x");\nwriteFileSync(path.join(dir, "f.txt"), "y");\nmkdirSync("test-results/ok", { recursive: true });\n',
      },
    ]);
    expect(sharedDirs(clean, ok), "a recorded, single-writer folder is not a defect").toEqual([]);
    expect(clean.filter((s) => s.origin === "temp").length, "mkdtemp target is per-run").toBe(1);

    // Positive control 1: a second file resolving a folder another file owns.
    const sharer = writeSites([
      { path: "tests/a.test.ts", source: 'mkdirSync("test-results/ok", { recursive: true });\n' },
      { path: "tests/b.test.ts", source: 'writeFileSync("test-results/ok/leak.txt", "y");\n' },
    ]);
    const shared = sharedDirs(sharer, ok);
    expect(shared.length, "a second writer of a recorded folder is reported").toBe(1);
    expect(shared[0].dir).toBe("test-results/ok");
    expect(shared[0].files).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);

    // Positive control 2: a brand-new folder nobody recorded.
    const novel = writeSites([{ path: "tests/c.test.ts", source: 'mkdirSync("test-results/brand-new");\n' }]);
    const fresh = sharedDirs(novel, ok);
    expect(fresh.length, "an unrecorded folder is reported").toBe(1);
    expect(fresh[0].expected).toEqual([]);

    // Positive control 3: the unrooted check is not blind either.
    const loose = writeSites([{ path: "tests/d.test.ts", source: 'writeFileSync("somewhere/shared.log", "y");\n' }]);
    expect(unrooted(loose).length, "a write with no root is reported").toBe(1);
  });
});
