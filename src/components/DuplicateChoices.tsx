"use client";
export type DuplicateChoice = { id: string; name: string; organisationId?: string };
export function DuplicateChoices({ matches, truncated, onUse }: { matches: DuplicateChoice[]; truncated: boolean; onUse: (match: DuplicateChoice) => void }) {
  return <div aria-label="Possible duplicate matches">{matches.map(match => <div key={match.id}><span>{match.name}</span> <button type="button" className="btn ghost sm" onClick={() => onUse(match)}>Use this one</button></div>)}{truncated && <p className="hint">Showing the first 5 matches. Search Accounts to see more.</p>}</div>;
}
