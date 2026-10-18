"use client";
// SHO-US-10.2 AC3/AC4: the Super Admin removes a stage. Deals in it move to a stage picked here; the last Done stage stays.
import { useState } from "react";
import { api } from "@/components/api";
import type { BoardStage } from "@/components/DealBoard";
import { Modal } from "@/components/ui";

export function StagesDialog({ pipeline, onClose, onDone }: { pipeline: { id: string; name: string; stages: BoardStage[] }; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState<{ stage: BoardStage; deals: number } | null>(null);
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function remove(stage: BoardStage, moveTo?: string) {
    setBusy(true); setErr(null);
    const r = await api("DELETE", `/api/deals/pipelines/${pipeline.id}/stages/${stage.id}`, moveTo ? { moveToStageId: moveTo } : undefined);
    setBusy(false);
    if (r.ok) { setTarget(null); onDone(); return; }
    if (r.data?.needsTarget) { setTarget({ stage, deals: r.data.deals as number }); setTo(""); return; }
    setErr(r.error ?? "Could not remove the stage.");
  }
  return (
    <Modal label={`${pipeline.name} stages`} onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>{pipeline.name} stages</h2>
      <p className="meta" style={{ justifyContent: "flex-start" }}>Removing a stage cannot be undone. A pipeline keeps at least one Done stage.</p>
      {err && <div className="err" role="alert">{err}</div>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {pipeline.stages.map((s) => (
          <li key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0" }}>
            <span style={{ flex: 1 }}>{s.name} <span className="chip grey">{s.category.toLowerCase().replace("_", " ")}</span></span>
            <button className="btn ghost sm" disabled={busy} onClick={() => remove(s)} aria-label={`Remove ${s.name}`}>Remove</button>
          </li>
        ))}
      </ul>
      {target && (
        <div className="card" style={{ marginTop: 10 }}>
          <b>{target.deals} deal{target.deals === 1 ? " is" : "s are"} in “{target.stage.name}”.</b>
          <div style={{ margin: "8px 0" }}>
            <label>Move {target.deals === 1 ? "it" : "them"} to{" "}
              <select className="in" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a stage</option>
                {pipeline.stages.filter((s) => s.id !== target.stage.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          <button className="btn danger sm" disabled={!to || busy} onClick={() => remove(target.stage, to)}>Move and remove “{target.stage.name}”</button>{" "}
          <button className="btn ghost sm" onClick={() => setTarget(null)}>Cancel</button>
        </div>
      )}
      <div style={{ marginTop: 12 }}><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
