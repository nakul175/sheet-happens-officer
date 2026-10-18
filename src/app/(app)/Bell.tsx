"use client";
// SHO-US-14.13: the bell keeps a notice unread until I act on it. Opening the panel marks nothing read;
// clicking a notice opens its task and marks it read; any notice can be marked unread again.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ago, api } from "@/components/api";
import "./bell.css";
import { bellEmptyText, responseApplies, visibleNotes, type BellFilter } from "./bell-list";

type Note = { id: string; text: string; href: string; read: boolean; createdAt: string };
type Page = { unread: number; items: Note[]; next: string | null };
const PAGE = 50;

export function Bell() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<BellFilter>("all");
  const [page, setPage] = useState<Page | null>(null);
  const [more, setMore] = useState<Note[]>([]); // older pages the person asked for
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const keep = useRef(PAGE); // how many are on screen, so a refresh does not throw away older pages
  const filterRef = useRef<BellFilter>("all");
  const loadSeq = useRef(0);

  const load = useCallback(async (f: BellFilter, reset = false) => {
    const mine = ++loadSeq.current;
    const limit = reset ? PAGE : Math.min(Math.max(keep.current, PAGE), 200);
    const r = await api<Page>("GET", `/api/notifications?limit=${limit}${f === "unread" ? "&filter=unread" : ""}`);
    // Mark-read reloads All. If Unread was selected while that was in flight, drop the All page.
    if (!responseApplies(f, filterRef.current, mine, loadSeq.current)) return;
    if (!r.ok) { setFailed(true); return; }
    setFailed(false);
    setPage(r.data);
    setMore([]);
    setNext(r.data.next);
    keep.current = r.data.items.length;
  }, []);
  // The badge needs the count even while the panel is shut; a minute is soon enough.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(filter, true); const t = setInterval(() => load(filter), 60_000); return () => clearInterval(t); }, [load, filter]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const unread = page?.unread ?? 0;
  const items = [...(page?.items ?? []), ...more];
  const shown = visibleNotes(filter, items);
  async function older() {
    if (!next) return;
    const mine = loadSeq.current;
    const f = filterRef.current;
    setLoadingMore(true);
    const r = await api<Page>("GET", `/api/notifications?limit=${PAGE}&before=${encodeURIComponent(next)}${f === "unread" ? "&filter=unread" : ""}`);
    setLoadingMore(false);
    if (!responseApplies(f, filterRef.current, mine, loadSeq.current)) return;
    if (!r.ok) { setFailed(true); return; }
    setMore((m) => [...m, ...r.data.items]);
    setNext(r.data.next);
    keep.current = items.length + r.data.items.length;
  }
  async function setRead(n: Note, read: boolean) {
    await api("POST", `/api/notifications/${n.id}/${read ? "read" : "unread"}`, {});
    // The tab may have moved to Unread while the mark request was in flight.
    await load(filterRef.current);
  }
  return (
    <div className="wrapper" ref={box}>
      <button className="bell" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open}
        onClick={() => { const o = !open; setOpen(o); if (o) load(filter); }}>
        🔔{unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="panel" role="dialog" aria-label="Notifications">
          <header>
            <span>Notifications</span>
            {unread > 0 && <button className="link" onClick={async () => { await api("POST", "/api/notifications/read-all", {}); await load(filterRef.current); }}>Mark all as read</button>}
          </header>
          <div className="bell-tabs" role="group" aria-label="Show">
            <button aria-pressed={filter === "all"} onClick={() => { filterRef.current = "all"; setFilter("all"); }}>All</button>
            <button aria-pressed={filter === "unread"} onClick={() => { filterRef.current = "unread"; setFilter("unread"); }}>Unread{unread > 0 ? ` · ${unread}` : ""}</button>
          </div>
          {failed && <div className="empty">Could not load notifications. <button className="link" onClick={() => load(filter, true)}>Try again</button></div>}
          {!failed && page && !shown.length && <div className="empty">{bellEmptyText(filter)}</div>}
          {shown.map((n) => (
            <div key={n.id} className={`row bell-row${!n.read ? " unread" : ""}`}>
              <Link href={n.href} className="bell-main"
                onClick={async (e) => {
                  e.preventDefault();
                  setOpen(false);
                  if (!n.read) await api("POST", `/api/notifications/${n.id}/read`, {});
                  load(filterRef.current);
                  router.push(n.href);
                }}>
                {!n.read && <span className="bell-dot" aria-label="Unread" role="img" />}
                {n.text}
                <small>{ago(n.createdAt)}</small>
              </Link>
              <button className="bell-tog" onClick={() => setRead(n, !n.read)} aria-label={n.read ? `Mark as unread: ${n.text}` : `Mark as read: ${n.text}`}>{n.read ? "Mark unread" : "Mark read"}</button>
            </div>
          ))}
          {next && <button className="link bell-more" disabled={loadingMore} onClick={older}>{loadingMore ? "Loading…" : "Load older"}</button>}
        </div>
      )}
    </div>
  );
}
