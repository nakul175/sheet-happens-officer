"use client";
import { useState } from "react";
import { api, useGet } from "@/components/api";

/** Set once dismissed in this tab, because the layout (and so the person record it was built from) is not re-read on client navigation. */
export const guide = { gone: false };

/**
 * SHO-US-14.4. At most three lines, above everything on My tasks. Dismiss is saved on the server,
 * so it stays gone on every device.
 */
export function StartGuide({ onDismiss }: { onDismiss: () => void }) {
  const leaders = useGet<{ kind: "LEADER" | "ADMIN"; people: { id: string; name: string }[] }>("/api/leaders");
  const [busy, setBusy] = useState(false);
  const names = leaders.data?.people.slice(0, 4).map((p) => p.name) ?? [];
  const more = (leaders.data?.people.length ?? 0) - names.length;
  async function dismiss() {
    setBusy(true);
    guide.gone = true;
    onDismiss(); // gone at once; the server remembers it
    await api("POST", "/api/profile/start-guide", {});
    setBusy(false);
  }
  return (
    <section className="guide" aria-label="Start guide">
      <div className="guide-head">
        <b>Welcome. Three things to know.</b>
        <button className="btn ghost sm" onClick={dismiss} disabled={busy}>Dismiss</button>
      </div>
      <ol>
        <li><b>This screen</b> lists every task assigned to you or shared with you, soonest first.</li>
        <li><b>Leaders</b> run projects and decide who joins.{" "}
          {names.length ? <>Ask {names.join(", ")}{more > 0 ? ` or ${more} more` : ""} to add you.</> : <>Ask an Admin to add you to a project.</>}
        </li>
        <li><b>To find a task</b>, press <kbd className="kbd">Ctrl K</kbd> or open Search.</li>
      </ol>
    </section>
  );
}
