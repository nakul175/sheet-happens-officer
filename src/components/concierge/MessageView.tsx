"use client";
import Link from "next/link";
import { useState } from "react";
import { useConcierge } from "./ConciergeProvider";
import { canShowConfirm, choicesActive, handoverComplete, initialPicks, undoView } from "./logic";
import type { Card, Message } from "./types";

function CardView({ card }: { card: Card }) {
  const c = useConcierge()!;
  const [picked, setPicked] = useState<Record<string, string>>(() => initialPicks(card));
  const pending = card.status === "PENDING";
  const ready = handoverComplete(card, picked);
  const options = card.handoverOptions ?? [];
  return (
    <section className={`cc-card${card.status === "STALE" ? " stale" : ""}`} aria-label={`Proposed change: ${card.title}`}>
      <h3>{card.title}</h3>
      {card.changes.length > 0 && (
        <ul className="cc-changes">
          {card.changes.map((ch, i) => (
            <li key={i}>
              <span className="cc-lbl">{ch.label}</span>
              {ch.before !== undefined && <span className="cc-before"><span className="sr">Before: </span>{ch.before}</span>}
              {ch.before !== undefined && ch.after !== undefined && <span aria-hidden="true" className="cc-arrow">→</span>}
              {ch.after !== undefined && <span className="cc-after"><span className="sr">After: </span>{ch.after}</span>}
            </li>
          ))}
        </ul>
      )}
      {card.handover && card.handover.length > 0 && (
        <div className="cc-handover">
          <p className="cc-note">This member holds these tasks. Choose who takes each one before you confirm.</p>
          {card.handover.map((h) => (
            <label key={h.taskId} className="cc-ho">
              <span>{h.taskTitle}</span>
              <select className="in" disabled={!pending} value={picked[h.taskId] ?? ""}
                onChange={(e) => setPicked((p) => ({ ...p, [h.taskId]: e.target.value }))}>
                <option value="">Choose a person…</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      {card.irreversible && pending && <p className="cc-warn" role="note">This can&apos;t be undone.</p>}
      {pending && card.blockedReason && <p className="cc-blocked" role="alert">{card.blockedReason}</p>}
      {card.status === "STALE" && <p className="cc-note">This changed since I prepared it. Nothing was written.</p>}
      {card.status === "CONFIRMED" && <p className="cc-note">Confirmed.</p>}
      {card.status === "CANCELLED" && <p className="cc-note">Cancelled. Nothing was changed.</p>}
      {pending && (
        <div className="cc-actions">
          {canShowConfirm(card) && (
            <button className="btn sm" disabled={c.busy || !ready}
              onClick={() => c.confirm(card.id, card.handover?.length ? card.handover.map((h) => ({ taskId: h.taskId, assigneeId: picked[h.taskId] })) : undefined)}>
              Confirm
            </button>
          )}
          <button className="btn ghost sm" disabled={c.busy} onClick={() => c.cancel(card.id)}>Cancel</button>
          {canShowConfirm(card) && !ready && <span className="cc-note">Choose someone for every task to continue.</span>}
        </div>
      )}
    </section>
  );
}

function ResultView({ m }: { m: Message }) {
  const c = useConcierge()!;
  const r = m.result!;
  const view = undoView(r);
  return (
    <div className="cc-result">
      <p>{m.text}</p>
      {r.summary.length > 0 && <ul>{r.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>}
      {r.noticeSent && <p className="cc-note">Someone was notified of this change. A notice cannot be unsent, so undoing will not take it back.</p>}
      {view === "button" && <button className="btn ghost sm" disabled={c.busy} onClick={() => c.undo(r.cardId)}>Undo</button>}
      {view === "expired" && <button className="btn ghost sm" disabled aria-disabled="true">Too old to undo</button>}
      {view === "undone" && <p className="cc-note">Undone.</p>}
      {view === "none" && <p className="cc-note">This can&apos;t be undone.</p>}
    </div>
  );
}

export function MessageView({ m }: { m: Message }) {
  const c = useConcierge()!;
  const mine = m.role === "USER";
  return (
    <li className={`cc-msg ${mine ? "me" : "bot"} k-${m.kind}`}>
      {m.kind === "card" && m.card ? (
        <>{m.text && <p>{m.text}</p>}<CardView card={m.card} /></>
      ) : m.kind === "result" && m.result ? (
        <ResultView m={m} />
      ) : (
        <p>{m.text}</p>
      )}
      {m.links && m.links.length > 0 && (
        <ul className="cc-links">
          {m.links.map((l, i) => <li key={i}><Link href={l.href}>{l.label}</Link></li>)}
        </ul>
      )}
      {m.kind === "choices" && m.choices && (
        <div className="cc-choices" role="group" aria-label="Choose one">
          {m.choices.map((ch) => {
            const active = choicesActive(c.messages, m);
            const picked = m.choiceAnswered === ch.id;
            return (
              <button key={ch.id} className={`cc-choice${picked ? " picked" : ""}`} disabled={!active || c.busy}
                aria-pressed={m.choiceAnswered ? picked : undefined} onClick={() => c.choose(m, ch.id)}>
                <span>{ch.label}</span>
                {ch.detail && <small>{ch.detail}</small>}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}
