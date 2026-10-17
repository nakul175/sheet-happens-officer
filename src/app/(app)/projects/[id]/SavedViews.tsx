"use client";
// SHO-US-14.10: name, rename and delete a saved view. The list of views lives in ProjectView; this is only the dialogs.
import { useState } from "react";
import { api } from "@/components/api";
import { Confirm, Field, Modal } from "@/components/ui";
import type { ListState } from "./listview";

export type SavedView = { id: string; name: string; state: ListState };

export function SaveViewDialog({ kind, projectId, state, view, onClose, onDone }: {
  kind: "save" | "rename" | "delete"; projectId: string; state: ListState; view?: SavedView; onClose: () => void; onDone: (afterDelete?: boolean) => void;
}) {
  const [name, setName] = useState(kind === "rename" ? view?.name ?? "" : "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (kind === "delete" && view) {
    return (
      <Confirm title={`Delete "${view.name}"?`} yes="Delete view" danger busy={busy} error={err} onNo={onClose}
        body="Only your own saved view is removed. The tasks are not touched."
        onYes={async () => { setBusy(true); const r = await api("DELETE", `/api/views/${view.id}`); setBusy(false); if (r.ok) onDone(true); else setErr(r.error ?? "Could not delete the view."); }} />
    );
  }
  const saving = kind === "save";
  return (
    <Modal small label={saving ? "Save view" : "Rename view"} onClose={onClose}>
      <h2>{saving ? "Save view" : "Rename view"}</h2>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = saving
          ? await api("POST", `/api/projects/${projectId}/views`, { name, state })
          : await api("PATCH", `/api/views/${view!.id}`, { name });
        setBusy(false);
        if (r.ok) onDone(); else setErr(r.error ?? "Could not save the view.");
      }}>
        <Field label="View name" hint="Only you see your saved views.">{(id) => <input id={id} className="in" value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />}</Field>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !name.trim()}>{saving ? "Save view" : "Save"}</button></div>
      </form>
    </Modal>
  );
}
