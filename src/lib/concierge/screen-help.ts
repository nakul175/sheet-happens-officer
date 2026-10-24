/** Server-owned capability routing only. No person lookup, inferred fact, model prose or mutation.
 * An anchored imperative avoids treating a quoted task title or a read question as a request to act.
 */
export function screenOnlyHelp(request: string): string | null {
  if (/^\s*(?:please\s+)?deactivate\s+(?:(?:the|a)\s+)?(?:person|user|member|account|editor)\b/i.test(request)) {
    return "Use the Team screen to deactivate a person if your role permits it. Nothing has changed.";
  }
  return null;
}
