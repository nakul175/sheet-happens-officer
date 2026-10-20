// Story specs that are Vitest files (`npm test` runs them) share tests/e2e/stories with the Playwright ones. Playwright
// fails at `import "vitest"` when it loads one and then lists nothing, so playwright.config.ts ignores every spec that
// imports vitest. scripts/ci/story-specs-no-vitest.test.mjs reads the same list. Plain CommonJS with no dependencies:
// Playwright loads the config as CommonJS, and CI runs that guard before `npm ci` (APL-2879, APL-2761).
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose, see above */
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

const STORIES = path.join(__dirname, "stories");

// A `/` after one of these (or after a keyword below) starts a regex literal; anywhere else it is division.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * `source` with comments and template text blanked and every quoted string replaced by "#<n>", where strings[n] is its text.
 * Only real code is left to match, so a comment, string or regex that mentions `from "vitest"` is not an import (APL-2892).
 */
function codeAndStrings(source) {
  const strings = [];
  let code = "";
  let last = "";
  let i = 0;
  const n = source.length;
  const regexAllowed = () => last === "" || REGEX_AFTER.test(last) || (/[\w$]/.test(last) && REGEX_AFTER_WORD.test(code.trimEnd()));
  function scan(inTemplate) {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      const d = source[i + 1];
      if (c === "/" && d === "/") {
        const e = source.indexOf("\n", i);
        i = e < 0 ? n : e;
        code += " ";
      } else if (c === "/" && d === "*") {
        const e = source.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
        code += " ";
      } else if (c === '"' || c === "'") {
        let s = "";
        for (i++; i < n && source[i] !== c && source[i] !== "\n"; i++) s += source[i] === "\\" ? source[++i] : source[i];
        i++;
        code += `"#${strings.push(s) - 1}"`;
        last = '"';
      } else if (c === "`") {
        code += "`";
        for (i++; i < n && source[i] !== "`"; ) {
          if (source[i] === "$" && source[i + 1] === "{") {
            i += 2;
            code += "${";
            scan(true); // the ${...} is code, and returns after its closing brace
            code += "}";
          } else i += source[i] === "\\" ? 2 : 1;
        }
        i++;
        code += "`";
        last = "`";
      } else if (c === "/" && regexAllowed()) {
        i++;
        for (let cls = false; i < n && source[i] !== "\n"; i++) {
          if (source[i] === "\\") i++;
          else if (source[i] === "[") cls = true;
          else if (source[i] === "]") cls = false;
          else if (source[i] === "/" && !cls) break;
        }
        for (i++; i < n && /[a-z]/i.test(source[i]); i++);
        code += " /re/ ";
        last = "/";
      } else {
        if (inTemplate && c === "}" && depth-- === 0) {
          i++;
          return;
        }
        if (inTemplate && c === "{") depth++;
        code += c;
        if (!/\s/.test(c)) last = c;
        i++;
      }
    }
  }
  scan(false);
  return { code, strings };
}

const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)"#(\d+)"/g;
const FROM = /\bfrom\s*"#(\d+)"/g;

/** Every module specifier in a file (`from`, side-effect `import`, `import()`, `require()`), outside comments and strings. */
function moduleSpecifiers(source) {
  const { code, strings } = codeAndStrings(source);
  return [...code.matchAll(SPECIFIERS)].map((m) => strings[Number(m[1])]);
}

/** True when the file itself has an `import ... from "vitest"` (or `export ... from`) statement. */
function importsFromVitest(source) {
  const { code, strings } = codeAndStrings(source);
  return [...code.matchAll(FROM)].some((m) => strings[Number(m[1])] === "vitest");
}

/** File names of the *.spec.ts files in `dir` that import vitest themselves. */
function vitestSpecFiles(dir = STORIES) {
  return readdirSync(dir).filter((f) => f.endsWith(".spec.ts") && importsFromVitest(readFileSync(path.join(dir, f), "utf8")));
}

/** playwright.config.ts testIgnore. Found by reading the files, so a new Vitest story never breaks `--list`. */
const VITEST_SPECS = vitestSpecFiles().map((f) => `**/stories/${f}`);

module.exports = { STORIES, codeAndStrings, moduleSpecifiers, importsFromVitest, vitestSpecFiles, VITEST_SPECS };
