"use client";
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ago, api, useGet } from "@/components/api";

type Person = { id: string; name: string };
type Comment = {
  id: string; text: string; createdAt: string; editedAt: string | null;
  author: Person; mentions: Person[]; canEdit: boolean; canDelete: boolean;
};
type Payload = { comments: Comment[]; members: Person[]; canComment: boolean };

/** The @query being typed, if the caret is inside one. */
function queryAt(value: string, pos: number) {
  const upto = value.slice(0, pos);
  const m = /(?:^|\s)@([^\n@]{0,60})$/.exec(upto);
  return m ? m[1] : null;
}

/**
 * Comments on a task. Rendered only when the task payload says comments are switched on,
 * so a flag-off server leaves the overlay as it was.
 */
export function Comments({ taskId, onChanged }: { taskId: string; onChanged?: () => void }) {
  const list = useGet<Payload>(`/api/tasks/${taskId}/comments`);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const posting = useRef(false);

  const members = list.data?.members ?? [];
  const query = closed ? null : queryAt(text, caret);
  const matches = query === null ? [] : members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  const shown = matches.length ? Math.min(active, matches.length - 1) : 0;
  const reload = list.reload;

  useEffect(() => {
    const on = () => { reload(); onChanged?.(); };
    window.addEventListener("sho:undone", on);
    return () => window.removeEventListener("sho:undone", on);
  }, [reload, onChanged]);

  function insert(name: string) {
    const upto = text.slice(0, caret);
    const at = upto.search(/(?:^|\s)@[^\n@]*$/);
    const start = at < 0 ? caret : upto[at] === "@" ? at : at + 1;
    const next = `${text.slice(0, start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setCaret(start + name.length + 2);
    setClosed(true);
    setActive(0);
  }

  async function submitNew(e: FormEvent) {
    e.preventDefault();
    if (posting.current || !text.trim()) return;
    posting.current = true;
    try {
      await send(`/api/tasks/${taskId}/comments`, "POST", { text }, () => { setText(""); setCaret(0); });
    } finally {
      posting.current = false;
    }
  }

  function pressAdd(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || e.currentTarget.disabled) return;
    // On a phone the tab bar can cover this button before pointerup, so the click never arrives.
    e.currentTarget.form?.requestSubmit();
  }

  async function send(path: string, method: string, body: unknown, after?: () => void) {
    setBusy(true);
    const res = await api(method, path, body);
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? "Could not save the comment."); return; }
    setErr(null);
    after?.();
    reload();
    onChanged?.();
  }

  const data = list.data;
  return (
    <section className="comments" aria-labelledby="comments-heading">
      <h3 id="comments-heading">Comments{data ? ` (${data.comments.length})` : ""}</h3>
      {list.loading && !data && <p className="hint">Loading comments…</p>}
      {list.error && !data && <p className="hint" role="alert">{list.error}</p>}
      {data && data.comments.length === 0 && <p className="hint">No comments yet.</p>}
      <div>
        {data?.comments.map((c) => (
          <article key={c.id} className="comment" aria-label={`Comment by ${c.author.name}`}>
            <div className="comment-meta">
              <b>{c.author.name}</b>
              <time dateTime={c.createdAt}>{ago(c.createdAt)}</time>
              {c.editedAt && <span className="hint">edited</span>}
            </div>
            {editing === c.id ? (
              <form onSubmit={(e) => { e.preventDefault(); void send(`/api/tasks/${taskId}/comments/${c.id}`, "PATCH", { text: draft }, () => setEditing(null)); }}>
                <label className="hint" htmlFor={`edit-${c.id}`}>Edit comment</label>
                <textarea id={`edit-${c.id}`} className="in" rows={3} value={draft} maxLength={5000} onChange={(e) => setDraft(e.target.value)} />
                <div className="actions">
                  <button className="btn sm" type="submit" disabled={busy}>Save</button>
                  <button className="btn ghost sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <p className="comment-text">{c.text}</p>
            )}
            {(c.canEdit || c.canDelete) && editing !== c.id && (
              <div className="actions">
                {c.canEdit && <button className="btn ghost sm" type="button" onClick={() => { setEditing(c.id); setDraft(c.text); }}>Edit comment</button>}
                {c.canDelete && <button className="btn ghost sm" type="button" onClick={() => void send(`/api/tasks/${taskId}/comments/${c.id}`, "DELETE", undefined)}>Delete comment</button>}
              </div>
            )}
          </article>
        ))}
      </div>
      {data?.canComment && (
        <form className="comment-form" onSubmit={(e) => { void submitNew(e); }}>
          <label htmlFor="new-comment">Add a comment</label>
          <textarea
            id="new-comment" className="in" rows={3} maxLength={5000} value={text}
            placeholder="Write a comment. Type @ to mention someone."
            aria-autocomplete="list" aria-controls={matches.length ? "mention-list" : undefined}
            aria-activedescendant={matches.length ? `mention-opt-${matches[shown].id}` : undefined}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setClosed(false); setActive(0); }}
            onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (!matches.length) return;
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % matches.length); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); }
              else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); insert(matches[shown].name); }
              else if (e.key === "Escape") { e.preventDefault(); setClosed(true); }
            }}
          />
          {matches.length > 0 && (
            <ul id="mention-list" role="listbox" aria-label="Mention a project member">
              {matches.map((m, i) => (
                <li
                  key={m.id}
                  id={`mention-opt-${m.id}`}
                  role="option"
                  aria-selected={i === shown}
                  tabIndex={-1}
                  className={i === shown ? "on" : ""}
                  onMouseDown={(e) => { e.preventDefault(); insert(m.name); }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setActive((n) => (n + 1) % matches.length); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((n) => (n - 1 + matches.length) % matches.length); }
                    else if (e.key === "Enter") { e.preventDefault(); insert(m.name); }
                    else if (e.key === "Escape") { e.preventDefault(); setClosed(true); }
                  }}
                >{m.name}</li>
              ))}
            </ul>
          )}
          {err && <p className="hint" role="alert">{err}</p>}
          <div className="actions">
            <button
              className="btn sm"
              type="submit"
              disabled={busy || !text.trim()}
              onPointerDown={pressAdd}
            >Add comment</button>
          </div>
        </form>
      )}
    </section>
  );
}
