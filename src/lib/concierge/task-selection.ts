/** Display-only routing for a supported imperative and ambiguity already returned by authorized reads.
 * This never creates operations or grants access. The existing card/confirm/version guards remain the write boundary.
 */
export function taskSelectionForRequest(
  request: string,
  ambiguity: readonly { kind: string; ids: readonly string[] }[],
  visibleTaskIds: ReadonlySet<string>,
  chosen: ReadonlySet<string>,
): { kind: "task"; ids: string[] } | undefined {
  if (!/^\s*(?:please\s+)?(?:move|assign|reassign|complete|delete|rename|mark|set|change|edit|block|unblock|reopen)\b/i.test(request)) return;
  // This fallback selects ONE target; explicit bulk requests retain their existing model/card flow.
  if (/\b(?:all|every|both)\b/i.test(request) || /^\s*(?:please\s+)?set\s+of\b/i.test(request)) return;
  for (const group of ambiguity) {
    if (group.kind !== "task") continue;
    const ids = [...new Set(group.ids)].filter(id => visibleTaskIds.has(id));
    if (ids.length > 1 && !ids.some(id => chosen.has(id))) return { kind: "task", ids };
  }
}
