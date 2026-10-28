// Refs SHO-2639. Public Sans has to come from the files in src/app/fonts, so a CI build has no font to fetch over the
// network. The wiring is next/font/local -> the --font-public-sans variable -> globals.css; this pins all three, and
// when a production build is present (CI builds before `npm test`) it also proves the font the app serves is the very
// file committed in this repo, not something downloaded at build time.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");
const layout = read("src", "app", "layout.tsx");
const globals = read("src", "app", "globals.css");

// A font that is not in the bundle would be fetched from one of these. None of them may appear in anything we ship.
const REMOTE_FONT = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function filesWith(...extensions: string[]) {
  return walk(path.join(ROOT, "src"))
    .concat(walk(path.join(ROOT, "public")))
    .filter((file) => extensions.some((ext) => file.endsWith(ext)));
}

describe("SHO-2639: Public Sans is loaded from this repo", () => {
  it("layout.tsx takes every face from src/app/fonts through next/font/local", () => {
    expect(layout, "next/font/local carries the font").toMatch(/from "next\/font\/local"/);
    expect(layout, "no Google font loader").not.toMatch(/next\/font\/google/);

    const sources = [...layout.matchAll(/path:\s*"\.\/fonts\/([^"]+)"/g)].map((match) => match[1]);
    expect(sources, "the three weights in the repo").toEqual([
      "PublicSans-Regular.woff2",
      "PublicSans-Medium.woff2",
      "PublicSans-SemiBold.woff2",
    ]);

    for (const name of sources) {
      const file = path.join(ROOT, "src", "app", "fonts", name);
      expect(existsSync(file), `${name} is committed`).toBe(true);
      const bytes = readFileSync(file);
      // A real WOFF2 starts with wOF2; anything else would fail the build at fontkit time, not at request time.
      expect(bytes.subarray(0, 4).toString("latin1"), `${name} is a WOFF2`).toBe("wOF2");
      expect(bytes.length, `${name} carries a font`).toBeGreaterThan(10_000);
    }

    // The licence has to travel with the files (SIL OFL 1.1, condition 2).
    expect(read("src", "app", "fonts", "OFL.txt")).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it("the face reaches the page through the CSS variable", () => {
    expect(layout, "the variable name is declared once").toMatch(/variable:\s*"--font-public-sans"/);
    expect(layout, "the variable class lands on <html>").toMatch(/className=\{publicSans\.variable\}/);
    expect(globals, "the body uses it").toMatch(/font-family:\s*var\(--font-public-sans\)/);
  });

  it("nothing we ship names a remote font host", () => {
    for (const file of filesWith(".css", ".tsx", ".ts", ".html", ".js")) {
      expect(readFileSync(file, "utf8"), path.relative(ROOT, file)).not.toMatch(REMOTE_FONT);
    }
  });

  it("a production build serves the vendored files themselves", () => {
    const media = path.join(ROOT, ".next", "static", "media");
    // No build in this checkout: CI runs `npm run build` before `npm test`, so there it always runs.
    if (!existsSync(media)) return;

    const vendored = readdirSync(path.join(ROOT, "src", "app", "fonts"))
      .filter((name) => name.endsWith(".woff2"))
      .map((name) => sha256(path.join(ROOT, "src", "app", "fonts", name)))
      .sort();
    const built = readdirSync(media)
      .filter((name) => name.endsWith(".woff2"))
      .map((name) => sha256(path.join(media, name)))
      .sort();
    expect(built, ".next holds the same bytes as src/app/fonts").toEqual(vendored);

    // Turbopack writes the stylesheets next to the chunks, not into static/css.
    const cssFiles = walk(path.join(ROOT, ".next", "static")).filter((file) => file.endsWith(".css"));
    expect(cssFiles.length, "the build emitted a stylesheet").toBeGreaterThan(0);
    const css = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(css, "the built CSS has no remote font host").not.toMatch(REMOTE_FONT);

    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((match) => match[1]);
    const fonts = urls.filter((url) => url.includes(".woff2"));
    expect(fonts.length, "a @font-face for every weight").toBeGreaterThanOrEqual(3);
    for (const url of urls) {
      // Same-origin only: either relative into the build's media folder, or an inline data URI.
      expect(!/^[a-z]+:\/\//i.test(url), `built CSS points at ${url}`).toBe(true);
      expect(url.startsWith("data:") || url.includes("/media/PublicSans_"), `built CSS points at ${url}`).toBe(true);
    }
  });
});
