// APL-2871: one rule for "the model only echoed what was typed", used by the server (engine.ts improvePrompt)
// and the composer (components/concierge/logic.ts offeredRewrite). No server imports, so the client can use it.

const QUOTES: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": "\"", "”": "\"", "„": "\"", "‟": "\"" };

/** Trim, lower-case, read curly quotes as straight ones, drop one wrapping pair of quotes and one trailing full stop. */
export function echoKey(text: string): string {
  let s = text.trim().toLowerCase().replace(/[‘’‚‛“”„‟]/g, (q) => QUOTES[q]);
  if (s.length >= 2 && (s[0] === "\"" || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1).trim();
  if (s.endsWith(".")) s = s.slice(0, -1).trimEnd();
  return s;
}

/** True when `reply` is the typed text again once both are normalised. Such a reply is no rewrite. */
export function isEcho(typed: string, reply: string): boolean {
  return echoKey(typed) === echoKey(reply);
}
