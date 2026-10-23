// SHO-3000. The @local-only exclusion list that the staging-regression summary prints, taken from the tags themselves.
//
// A spec is @local-only when a test or describe carries the tag, either as `{ tag: "@local-only" }` or at the end of a
// test title. A plain mention in a comment does not count: APL-2742.spec.ts explains the tag in its header comment and
// also carries it on the describe, and only the second one is a tag.
//
// One source, so the workflow and its test cannot drift: the workflow prints the line this module builds, and
// scripts/ci/local-only-specs.test.mjs reads the same function back against the real story files.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const STORIES = join(ROOT, "tests/e2e/stories");

/** A line that is a comment, not code: `// …` or a block-comment continuation. */
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** `{ tag: "@local-only" }`, `tag: ['@local-only']`, either quote. A describe-level tag covers its whole file. */
const TAG = /tag:\s*(?:\[\s*)?["'`]@local-only["'`]/;
/** A title that ends in the tag, i.e. the tag is part of the test name --grep-invert matches. */
const TITLE = /["'`]([^"'`]*)@local-only["'`]/;

/** `AC4: …` in a title, so APL-2471's one tagged test prints as "APL-2471 AC4" and not the whole file. */
const acOf = (title) => title.trim().match(/^(AC\d+)\b/)?.[1] ?? null;

/**
 * The labels to print for one story file's source, without its extension: the file id for a describe-level tag,
 * `id AC<n>` for a tagged test title. A comment-only mention yields nothing.
 */
export function labelsIn(id, source) {
  const out = new Set();
  for (const line of source.split("\n")) {
    if (isComment(line)) continue;
    if (TAG.test(line)) { out.add(id); continue; }
    const title = line.match(TITLE)?.[1];
    if (title === undefined) continue;
    const ac = acOf(title);
    out.add(ac ? `${id} ${ac}` : id);
  }
  return [...out];
}

/** Every label in the story directory, sorted so two runs print the same line. */
export function labels(dir = STORIES) {
  const all = new Set();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".spec.ts")).sort()) {
    for (const label of labelsIn(name.slice(0, -".spec.ts".length), readFileSync(join(dir, name), "utf8"))) all.add(label);
  }
  return [...all].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** The markdown line the staging-regression summary prints. */
export const summaryLine = (dir = STORIES) => `**Excluded (@local-only):** ${labels(dir).join(", ")}.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(process.argv.includes("--summary") ? summaryLine() : labels().join(", "));
}
