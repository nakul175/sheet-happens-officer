/** Shared Stage A search contract. No model, embeddings, query logging or HTML excerpts. */
export type SearchKind = "TASK" | "PROJECT" | "DEAL" | "ORGANISATION" | "CONTACT" | "NOTE";
export type SearchHit = {
  id: string;
  type: SearchKind;
  title: string;
  href: string;
  matchedField: string;
  excerpt: string;
  score: number;
};

export const SEARCH_LIMIT = 25;
export const SEARCH_MAX_QUERY = 200;

/** Bound tokens before constructing SQL; values remain bound parameters, never SQL syntax. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [])]
    .filter((word) => word.length >= 2).slice(0, 12);
}

/** Excerpt positioning only; PostgreSQL remains the ranking authority. */
function oneTypo(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differences = [...a].flatMap((char, i) => char === b[i] ? [] : [i]);
    return differences.length <= 1 || (differences.length === 2 && differences[1] === differences[0] + 1
      && a[differences[0]] === b[differences[1]] && a[differences[1]] === b[differences[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

/** Plain text only. React renders this as text; source markup is never interpreted. */
export function searchExcerpt(value: string, terms: string[], limit = 220): string {
  const text = value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const lower = text.toLocaleLowerCase("en-US");
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  // A stem or typo may have no literal query substring. Centre its excerpt on
  // the matching word rather than showing an unrelated start of a long note.
  if (!positions.length) for (const word of lower.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)) {
    if (terms.some((term) => (term.endsWith("s") && word[0] === term.slice(0, -1))
      || (term.length >= 6 && oneTypo(term, word[0])))) { positions.push(word.index); break; }
  }
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 45);
  const excerpt = text.slice(start, start + limit);
  return `${start ? "…" : ""}${excerpt}${start + limit < text.length ? "…" : ""}`;
}
