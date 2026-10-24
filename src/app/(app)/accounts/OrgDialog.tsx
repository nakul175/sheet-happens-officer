"use client";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field, Modal } from "@/components/ui";
import { organisationKindOptions } from "@/lib/org-kinds";

type Organisation = {
  id: string; name: string; kind: string | null; country: string | null;
  parentId: string | null; level: "GROUP" | "LEGAL_ENTITY" | "BUYING_OFFICE" | null;
  path: { id: string; name: string }[];
};

export default function OrgDialog({ organisation, onClose, onDone }: {
  organisation?: Organisation; onClose: () => void; onDone: (id: string) => void;
}) {
  const all = useGet<{ organisations: { id: string; name: string }[] }>("/api/orgs");
  const [v, setV] = useState({ name: organisation?.name ?? "", kind: organisation?.kind ?? "", country: organisation?.country ?? "", parentId: organisation?.parentId ?? "", level: organisation?.level ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setV({ ...v, [k]: e.target.value });
    setDup(false);
    setErr(null);
  };
  async function save(force = false) {
    if (saving) return;
    setSaving(true);
    const body = { name: v.name, kind: v.kind || null, country: v.country || null, parentId: v.parentId || null, level: v.level || null };
    try {
      const r = organisation
        ? await api("PATCH", `/api/orgs/${organisation.id}`, body)
        : await api("POST", "/api/orgs", { ...body, force });
      if (r.ok) onDone(organisation?.id ?? r.data.organisation.id);
      else { setDup(!organisation && r.data?.needsConfirm === "duplicate"); setErr(r.error ?? "Could not save."); }
    } catch { setErr("Could not save. Please try again."); }
    finally { setSaving(false); }
  }
  const parents = (all.data?.organisations ?? []).filter((o) => o.id !== organisation?.id);
  // An archived parent is absent from the active list but must not be lost on an unrelated edit.
  const currentParent = organisation?.path.find((o) => o.id === organisation.parentId);
  return (
    <Modal onClose={onClose} label={organisation ? "Edit organisation" : "New organisation"}>
      <h2>{organisation ? "Edit organisation" : "New organisation"}</h2>
      <Field label="Name">{(id) => <input id={id} className="in" value={v.name} onChange={set("name")} />}</Field>
      <Field label="Kind (optional)">{(id) => <select id={id} className="in" value={v.kind} onChange={set("kind")}><option value="">Not specified</option>{organisationKindOptions(organisation?.kind).map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>}</Field>
      <Field label="Country">{(id) => <input id={id} className="in" value={v.country} onChange={set("country")} />}</Field>
      <Field label="Hierarchy level (optional)">{(id) => <select id={id} className="in" value={v.level} onChange={set("level")}><option value="">Not specified</option><option value="GROUP">Group</option><option value="LEGAL_ENTITY">Legal entity</option><option value="BUYING_OFFICE">Buying office</option></select>}</Field>
      <Field label="Sits under (optional)">{(id) => <select id={id} className="in" value={v.parentId} onChange={set("parentId")}><option value="">Top level</option>{currentParent && !parents.some((o) => o.id === currentParent.id) && <option value={currentParent.id}>{currentParent.name} (current parent)</option>}{parents.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}</Field>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions">
        <button className="btn ghost" disabled={saving} onClick={onClose}>Cancel</button>
        {dup && <button className="btn ghost" disabled={saving} onClick={() => save(true)}>Add anyway</button>}
        <button className="btn" disabled={saving || !v.name.trim()} onClick={() => save()}>{saving ? "Saving…" : organisation ? "Save" : "Add"}</button>
      </div>
    </Modal>
  );
}
