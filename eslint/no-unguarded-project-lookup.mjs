/**
 * Flags hand-written project reads (SHO-BUG-11 / APL-2659).
 *
 * A call like db.project.findMany (also tx.project, and findFirst / findUnique / count,
 * including the OrThrow forms and static bracket notation) is only allowed when:
 *   - it lives in the module that defines the visibility helpers (src/lib/access.ts), or
 *   - an argument calls visibleProjects, myProjects, or projectAccess, or
 *   - the call carries `// project-lookup-ok: <reason>` on the line above it, on its
 *     own lines, or at the end of the call. The reason must be non-empty.
 */

const HELPERS = new Set(["visibleProjects", "myProjects", "projectAccess"]);
const METHODS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
]);

function norm(filename) {
  return String(filename ?? "").replaceAll("\\", "/");
}

export function isHelperModule(filename) {
  return /(^|\/)src\/lib\/access\.ts$/.test(norm(filename));
}

export function inSrc(filename) {
  return /(^|\/)src\//.test(norm(filename));
}

function propertyName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return null;
}

function projectMethod(node) {
  const method = propertyName(node.callee);
  return METHODS.has(method) && propertyName(node.callee.object) === "project" ? method : null;
}

function usesHelper(root) {
  const seen = new Set();
  const stack = [...(root.arguments ?? [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && HELPERS.has(node.callee.name)) return true;
    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === "object" && c.type) stack.push(c);
      } else if (child && typeof child === "object" && child.type) stack.push(child);
    }
  }
  return false;
}

function hasAllow(sourceCode, node) {
  const start = node.loc?.start.line;
  const end = node.loc?.end.line;
  if (!start || !end) return false;
  return sourceCode.getAllComments().some((c) => {
    const line = c.loc.end.line;
    const near = line === start - 1 || (line >= start && line <= end);
    return near && /project-lookup-ok:\s*\S/.test(c.value);
  });
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow db.project lookups that skip visibleProjects, myProjects, or projectAccess",
    },
    schema: [],
    messages: {
      unguarded:
        "Direct db.project.{{method}} skips the visibility filters. Use visibleProjects, myProjects, or projectAccess, or mark a true bypass with // project-lookup-ok: <reason>.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!inSrc(filename) || isHelperModule(filename)) return {};
    return {
      CallExpression(node) {
        const method = projectMethod(node);
        if (!method) return;
        if (usesHelper(node)) return;
        if (hasAllow(context.sourceCode ?? context.getSourceCode(), node)) return;
        context.report({ node, messageId: "unguarded", data: { method } });
      },
    };
  },
};

export default rule;
