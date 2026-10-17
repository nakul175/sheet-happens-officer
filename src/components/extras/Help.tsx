"use client";
import { Modal } from "@/components/ui";

const GROUPS: { title: string; rows: [string[], string][] }[] = [
  { title: "Anywhere", rows: [
    [["C"], "New task"],
    [["/"], "Search"],
    [["Ctrl", "K"], "Search and commands (Cmd K on a Mac)"],
    [["G", "M"], "Go to My tasks"],
    [["G", "P"], "Go to Projects"],
    [["?"], "Show this list"],
  ] },
  { title: "In a list", rows: [
    [["J"], "Next row"],
    [["K"], "Previous row"],
    [["Enter"], "Open the row"],
    [["X"], "Complete the task"],
    [["E"], "Open the task and choose who it is assigned to"],
  ] },
];

/** SHO-US-14.6 AC1: every shortcut, in one sheet. */
export function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal small label="Keyboard shortcuts" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      {GROUPS.map((g) => (
        <section key={g.title} aria-label={g.title}>
          <div className="grp">{g.title}</div>
          <dl className="keys">
            {g.rows.map(([keys, what]) => (
              <div key={what}>
                <dt>{keys.map((k, i) => <span key={k}>{i > 0 && (g.title === "Anywhere" && keys.length === 2 && keys[0] === "G" ? " then " : " + ")}<kbd className="kbd">{k}</kbd></span>)}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="hint">Single keys pause while you type in a field or while a dialog is open. Your browser&apos;s and screen reader&apos;s own keys are never overridden.</p>
      <div className="actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
