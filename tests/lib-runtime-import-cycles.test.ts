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
  return [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]
    .find((candidate) => known.has(candidate)) ?? null;
}

function dynamicSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function findCycle(graph: Map<string, string[]>): string[] | null {
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
  return [...graph.keys()].map(visit).find(Boolean) ?? null;
}

it("recognizes nested literal dynamic imports while excluding computed imports", () => {
  const source = ts.createSourceFile("sample.ts", 'async function load() { await import("./db.ts"); await import(variable); }', ts.ScriptTarget.Latest, true);
  expect(dynamicSpecifiers(source)).toEqual(["./db.ts"]);
  expect(localTarget(join(lib, "shutdown.ts"), "./db.ts")).toBe(join(lib, "db.ts"));
  const synthetic = new Map([["shutdown.ts", ["db.ts"]], ["db.ts", ["shutdown.ts"]]]);
  expect(findCycle(synthetic)).toEqual(["shutdown.ts", "db.ts", "shutdown.ts"]);
});

it("src/lib has no static or literal dynamic runtime import cycles", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const staticTargets = source.statements.flatMap((node) => {
      const specifier = runtimeSpecifier(node);
      const target = specifier && localTarget(file, specifier);
      return target ? [target] : [];
    });
    const dynamicTargets = dynamicSpecifiers(source).flatMap((specifier) => {
      const target = localTarget(file, specifier);
      return target ? [target] : [];
    });
    graph.set(file, [...staticTargets, ...dynamicTargets]);
  }
  expect(graph.size).toBeGreaterThan(50); // fail if the scan path silently changes
  expect([...graph.values()].reduce((count, edges) => count + edges.length, 0)).toBeGreaterThan(100);
  const cycle = findCycle(graph);
  expect(cycle?.map((file) => file.slice(lib.length + 1))).toBeUndefined();
});
