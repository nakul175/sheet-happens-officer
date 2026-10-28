"use client";
import { useState } from "react";
import { useGet } from "@/components/api";
import { Confirm } from "@/components/ui";
export type WorkspaceTaskCandidate = { id: string; name: string; isMember: boolean };
/** Managers explicitly confirm the access grant. This control never silently joins someone to a project. */
export function WorkspaceTaskPerson({ projectId, purpose, onChoose, whenSaved = false, excludeIds = [] }: {
  projectId: string; purpose: "assignee" | "collaborator"; whenSaved?: boolean; excludeIds?: string[];
  onChoose: (person: WorkspaceTaskCandidate, addToProject: boolean) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<WorkspaceTaskCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();
  const results = useGet<{ people: WorkspaceTaskCandidate[] }>(q.length >= 2 ? `/api/projects/${projectId}/assignment-people?purpose=${purpose}&q=${encodeURIComponent(q)}` : null);
  async function choose(person: WorkspaceTaskCandidate, addToProject: boolean) {
    setBusy(true); setError(null);
    const result = await onChoose(person, addToProject);
    setBusy(false);
    if (result.ok) { setChosen(null); setQuery(""); } else setError(result.error ?? "Could not save this task change. Try again.");
  }
  return <div style={{ width: "100%", marginTop: 8 }}>
    <label className="hint">Search workspace {purpose === "assignee" ? "assignees" : "collaborators"}
      <input className="in" aria-label={`Search workspace ${purpose === "assignee" ? "assignees" : "collaborators"}`} placeholder="Type at least 2 letters of a name" value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setError(null); }} />
    </label>
    {q.length >= 2 && results.loading && <p className="hint" role="status">Searching…</p>}
    {q.length >= 2 && results.error && <p className="err" role="alert">Could not search workspace people. Try again.</p>}
    {q.length >= 2 && !results.loading && results.data?.people?.length === 0 && <p className="hint">No eligible active workspace people match.</p>}
    {results.data?.people?.filter(person => !excludeIds.includes(person.id)).map(person => <div key={person.id} className="pills" style={{ marginTop: 6 }}>
      <span>{person.name} · {person.isMember ? "Project member" : "Not in this project"}</span>
      <button className="btn ghost sm" type="button" disabled={busy} onClick={() => person.isMember ? void choose(person, false) : setChosen(person)}>{purpose === "assignee" ? "Choose assignee" : "Choose collaborator"}</button>
    </div>)}
    {error && !chosen && <p className="err" role="alert">{error}</p>}
    {chosen && <Confirm title={`Add ${chosen.name} to this project?`} yes={purpose === "assignee" ? "Add to project and assign" : "Add to project and collaborate"} busy={busy} error={error} onNo={() => { if (!busy) { setChosen(null); setError(null); } }} onYes={() => choose(chosen, true)}
      body={`${whenSaved ? "When you save this task, this" : "This"} person will become an Editor and gain access to this project. Undoing the task change will not remove their project access. ${purpose === "assignee" ? "They will be the task's assignee." : "They will be a task collaborator."}`} />}
  </div>;
}
