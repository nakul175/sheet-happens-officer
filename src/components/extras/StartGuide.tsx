"use client";
import { useEffect, useState } from "react";
import { api, useGet } from "@/components/api";
import { INSTALL_GUIDANCE } from "@/lib/install-guidance";
const INSTALL_DISMISSED = "sho.install-tip.dismissed";

/** Set once dismissed in this tab, because the layout (and so the person record it was built from) is not re-read on client navigation. */
export const guide = { gone: false };

/**
 * SHO-US-14.4. At most three lines, above everything on My tasks. Dismiss is saved on the server,
 * so it stays gone on every device.
 */
export function StartGuide({ onDismiss }: { onDismiss: () => void }) {
  const leaders = useGet<{ kind: "LEADER" | "ADMIN"; people: { id: string; name: string }[] }>("/api/leaders");
  const [busy, setBusy] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 599px)");
    const standalone = window.matchMedia("(display-mode: standalone)");
    const update = () => {
      let dismissed = false;
      try { dismissed = localStorage.getItem(INSTALL_DISMISSED) === "1"; } catch { /* A blocked storage API must not break the guide. */ }
      setShowInstall(phone.matches && !standalone.matches && !(navigator as Navigator & { standalone?: boolean }).standalone && !dismissed);
    };
    update(); phone.addEventListener("change", update); standalone.addEventListener("change", update);
    return () => { phone.removeEventListener("change", update); standalone.removeEventListener("change", update); };
  }, []);
  function dismissInstall() {
    try { localStorage.setItem(INSTALL_DISMISSED, "1"); } catch { /* Still dismiss for this visit when storage is blocked. */ }
    setShowInstall(false);
  }
  const names = leaders.data?.people.slice(0, 4).map((p) => p.name) ?? [];
  const more = (leaders.data?.people.length ?? 0) - names.length;
  async function dismiss() {
    setBusy(true);
    if (showInstall) dismissInstall();
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
        <li><b>This screen</b> lists every task assigned to you or shared with you, soonest first.{showInstall && <> To find a task, press <kbd className="kbd">Ctrl K</kbd> or open Search.</>}</li>
        <li><b>Leaders</b> run projects and decide who joins.{" "}
          {names.length ? <>Ask {names.join(", ")}{more > 0 ? ` or ${more} more` : ""} to add you.</> : <>Ask an Admin to add you to a project.</>}
        </li>
        {showInstall ? <li><b>On your Home Screen</b><br />{INSTALL_GUIDANCE.split("\n").map(line => <span key={line} style={{ display: "block" }}>{line}</span>)}<button type="button" className="btn ghost sm" style={{ minHeight: 44 }} onClick={dismissInstall}>Dismiss install tip</button></li> : <li><b>To find a task</b>, press <kbd className="kbd">Ctrl K</kbd> or open Search.</li>}
      </ol>
    </section>
  );
}
