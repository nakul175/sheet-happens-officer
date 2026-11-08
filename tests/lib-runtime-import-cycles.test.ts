import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";

const lib = resolve(process.cwd(), "src/lib");
const files = readdirSync(lib, { recursive: true })
  .filter((name): name is string => typeof name === "string" && /\.tsx?$/.test(name))
  .map((name) => join(lib, name));
const known = new Set(files);

function runtimeSpecifier(node: ts.Statement): string | null {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return null;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
      && !clause.name && clause.namedBindings.elements.length > 0
      && clause.namedBindings.elements.every((item) => item.isTypeOnly)) return null;
    return node.moduleSpecifier.text;
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    if (node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length > 0 && node.exportClause.elements.every((item) => item.isTypeOnly))) return null;
    return node.moduleSpecifier.text;
  }
  return null;
}

function localTarget(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/lib/") ? join(lib, specifier.slice(6))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  return [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]
    .find((candidate) => known.has(candidate)) ?? null;
}

it("src/lib has no static runtime import cycles", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    graph.set(file, source.statements.flatMap((node) => {
      const specifier = runtimeSpecifier(node);
      const target = specifier && localTarget(file, specifier);
      return target ? [target] : [];
    }));
  }
  expect(graph.size).toBeGreaterThan(50); // fail if the scan path silently changes
  expect([...graph.values()].reduce((count, edges) => count + edges.length, 0)).toBeGreaterThan(100);
  const active = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(file: string): string[] | null {
    if (active.has(file)) return [...path.slice(path.indexOf(file)), file];
    if (visited.has(file)) return null;
    active.add(file); path.push(file);
    for (const target of graph.get(file) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop(); active.delete(file); visited.add(file);
    return null;
  }
  const cycle = files.map(visit).find(Boolean);
  expect(cycle?.map((file) => file.slice(lib.length + 1))).toBeUndefined();
});
