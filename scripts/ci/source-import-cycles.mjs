// Keep hand-maintained application modules free of static import cycles.
// Generated Prisma files have their own generated dependency graph and are excluded.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function findImportCycles(graph) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  const cycles = [];
  function visit(node) {
    index.set(node, next);
    low.set(node, next++);
    stack.push(node);
    active.add(node);
    for (const child of graph.get(node) ?? []) {
      if (!graph.has(child)) continue;
      if (!index.has(child)) {
        visit(child);
        low.set(node, Math.min(low.get(node), low.get(child)));
      } else if (active.has(child)) {
        low.set(node, Math.min(low.get(node), index.get(child)));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let child;
    do {
      child = stack.pop();
      active.delete(child);
      component.push(child);
    } while (child !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component.sort());
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

export function sourceImportGraph(cwd = process.cwd()) {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('TS_CONFIG_MISSING');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error('TS_CONFIG_INVALID');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length) throw new Error('TS_CONFIG_INVALID');
  const srcRoot = path.join(cwd, 'src') + path.sep;
  const generatedRoot = path.join(cwd, 'src', 'generated') + path.sep;
  const files = parsed.fileNames.map((file) => path.resolve(file))
    .filter((file) => file.startsWith(srcRoot) && !file.startsWith(generatedRoot) && /\.tsx?$/.test(file));
  const graph = new Map(files.map((file) => [file, []]));
  for (const file of files) {
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
    const specs = [];
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
        specs.push(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(source);
    for (const spec of specs) {
      const resolved = ts.resolveModuleName(spec, file, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
      const target = resolved ? path.resolve(resolved) : null;
      if (target && graph.has(target)) graph.get(file).push(target);
    }
  }
  return graph;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const graph = sourceImportGraph();
  const cycles = findImportCycles(graph);
  if (cycles.length) {
    for (const cycle of cycles)
      console.error('SOURCE_IMPORT_CYCLE', cycle.map((file) => path.relative(process.cwd(), file)).join(' -> '));
    process.exitCode = 1;
  } else {
    console.log(`SOURCE_IMPORT_CYCLES_OK ${graph.size} files`);
  }
}
