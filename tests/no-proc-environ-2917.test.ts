// SHO-2917 / SHO-3031. Test code must never read the complete process environment image.
// Analyse only filesystem-read argument expressions; unrelated proc paths and route/title text
// elsewhere in the same file must not create a file-level false positive.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SELF = path.join("tests", "no-proc-environ-2917.test.ts");
const BANNED = /\/proc\/(?:self|\d*|[^/\s]*)\/environ\b/;

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

function expressionText(node: ts.Node, constants: Map<string, ts.Expression>, seen = new Set<string>()): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
    return (node as ts.TemplateLiteralToken).text;
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return "";
    const value = constants.get(node.text);
    if (!value) return "";
    return expressionText(value, constants, new Set([...seen, node.text]));
  }
  if (ts.isCallExpression(node) && /(?:^|\.)join$/.test(node.expression.getText())) {
    return node.arguments.map((argument) => expressionText(argument, constants, seen)).join("/");
  }
  let text = "";
  node.forEachChild((child) => { text += expressionText(child, constants, seen); });
  return text;
}

/** Files containing a filesystem read whose own path expression constructs /proc/<pid|self>/environ. */
export function environReaders(files: { file: string; text: string }[]) {
  return files.filter(({ file, text }) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const constants = new Map<string, ts.Expression>();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
      node.forEachChild(collect);
    };
    collect(source);
    let found = false;
    const scan = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        if (/(?:^|\.)(?:readFile|readFileSync|open|openSync)$/.test(callee) && node.arguments[0]) {
          if (BANNED.test(expressionText(node.arguments[0], constants))) found = true;
        }
      }
      if (!found) node.forEachChild(scan);
    };
    scan(source);
    return found;
  }).map(({ file }) => file);
}

describe("SHO-3031: proc-environ guard is expression-scoped", () => {
  it("finds real direct and constructed reads", () => {
    for (const text of [
      `readFileSync("/proc/self/environ")`,
      "readFileSync(`/proc/${process.pid}/environ`)",
      `readFileSync(path.join("/proc", "self", "environ"))`,
      `const dir="/proc/self/"; readFileSync(dir + "environ")`,
      `const root="/proc"; readFileSync(\`${"${root}"}/${"${process.pid}"}/environ\`)`,
    ]) expect(environReaders([{ file: "bad.ts", text }]), text).toEqual(["bad.ts"]);
  });

  it("does not combine unrelated proc and environ text from one file", () => {
    for (const text of [
      `readFileSync("/proc/cpuinfo"); app.get("/environ", handler)`,
      `const cpu="/proc/cpuinfo"; it("environ route", () => expect(cpu).toBeTruthy())`,
      `readFileSync("/proc/self/stat"); describe("environ", () => {})`,
    ]) expect(environReaders([{ file: "safe.ts", text }]), text).toEqual([]);
  });

  it("finds no process-environment reader under tests", () => {
    const files = filesUnder("tests").filter((file) => file !== SELF).map((file) => ({ file, text: readFileSync(file, "utf8") }));
    expect(files.length).toBeGreaterThan(50);
    expect(environReaders(files)).toEqual([]);
  });
});
