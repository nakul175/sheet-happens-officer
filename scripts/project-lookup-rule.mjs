// SHO-2659: visibility-sensitive project reads need a helper or a reviewable exception.
const READS = new Set(['findFirst', 'findMany', 'findUnique', 'count']);
const name = (node) => node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : undefined;
const member = (node, property) => node?.type === 'MemberExpression' && name(node.property) === property;
const scoped = (argument) => {
  if (argument?.type !== 'ObjectExpression') return false;
  const where = argument.properties.find((p) => p.type === 'Property' && name(p.key) === 'where')?.value;
  return where?.type === 'ObjectExpression' && where.properties.some((p) =>
    p.type === 'SpreadElement' && p.argument.type === 'CallExpression' &&
    ['visibleProjects', 'myProjects'].includes(name(p.argument.callee)));
};
export default {
  meta: { type: 'problem', schema: [], messages: {
    visibility: 'Use visibleProjects, myProjects or projectAccess for project reads, or add // project-lookup-ok: <reason> on the preceding line.',
  } },
  create(context) {
    const source = context.sourceCode;
    return { CallExpression(node) {
      const call = node.callee;
      if (call.type !== 'MemberExpression' || !READS.has(name(call.property)) ||
          !member(call.object, 'project') || name(call.object.object) !== 'db') return;
      const reason = source.getAllComments().some((comment) =>
        comment.loc.end.line === node.loc.start.line - 1 && /^\s*project-lookup-ok:\s*\S/.test(comment.value));
      if (!reason && !scoped(node.arguments[0])) context.report({ node, messageId: 'visibility' });
    } };
  },
};
