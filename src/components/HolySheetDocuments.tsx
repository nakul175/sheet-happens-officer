'use client';
import { HolySheetEditor, type HostSessionProvider } from '@aplyd/holy-sheet-editor/hosted';
import { useEffect, useRef, useState, useMemo } from 'react';
type Context = {
    hostOrigin?:string;
    origin: string;
    subject: string;
    canWrite: boolean;
    links: {
        pageId: string;
    }[];
    defaultSpaceId: string | null;
};
type Selection = {
    pageId: string;
    spaceId: string;
    created: boolean;
    setDefault?: boolean;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function HolySheetDocuments({ kind, id }: {
    kind: 'projects' | 'tasks';
    id: string;
}) {
    const endpoint = `/api/${kind}/${encodeURIComponent(id)}/documents`;
    const [context, setContext] = useState<Context | null>(null), [visible, setVisible] = useState(false), [error, setError] = useState(''), [frame, setFrame] = useState(''), [picker, setPicker] = useState(''), [pending, setPending] = useState<Selection | null>(null), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
    const verified = useRef<Context | null>(null), iframe = useRef<HTMLIFrameElement>(null), active = useRef(true), channel = useRef(''), mutation = useRef(false), epoch = useRef(0), checks = useRef(0);
    const provider = useMemo<HostSessionProvider>(() => ({ async check({ signal }) {
            const response = await fetch(endpoint, { cache: 'no-store', signal });
            if (response.status === 401)
                return { status: 'signin' };
            if (!response.ok)
                return { status: 'unavailable' };
            const data = await response.json();
            if (data.origin !== 'https://staging.holysheet.aplyd.org' || data.subject !== context?.subject)
                return { status: 'signin' };
            return { status: 'ready', origin: data.origin, subject: data.subject };
        } }), [endpoint, context?.subject]);
    const key = (subject: string) => `sho.hs.pending:${subject}:${kind}:${id}`;
    useEffect(() => {
        active.current = true;
        function lock() { epoch.current++; verified.current = null; setContext(null); setFrame(''); setPicker(''); setPending(null); }
        async function check() {
            const attempt = ++checks.current;
            try {
                const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                if (!active.current || attempt !== checks.current)
                    return;
                if (response.status === 404) {
                    lock();
                    setVisible(false);
                    return;
                }
                setVisible(true);
                if (!response.ok)
                    throw Error('Sign in with Aplyd and check your SHO access, then retry.');
                const data: Context = await response.json();
                if (!active.current || attempt !== checks.current)
                    return;
                if (data.origin !== 'https://staging.holysheet.aplyd.org' || !data.subject || !Array.isArray(data.links))
                    throw Error('Holy Sheet access could not be checked.');
                if (verified.current && verified.current.subject !== data.subject)
                    lock();
                verified.current = data;
                setContext(data);
                setError('');
                if (!data.canWrite) {
                    setPicker('');
                    setPending(null);
                }
                else
                    try {
                        const saved = JSON.parse(sessionStorage.getItem(key(data.subject)) ?? 'null');
                        if (saved && uuid.test(saved.pageId) && typeof saved.spaceId === 'string' && typeof saved.created === 'boolean')
                            setPending(saved);
                    }
                    catch { }
            }
            catch (e) {
                if (active.current && attempt === checks.current) {
                    lock();
                    setVisible(true);
                    setError(e instanceof Error ? e.message : 'Holy Sheet is unavailable.');
                }
            }
        }
        void check();
        const focus = () => void check(), timer = setInterval(focus, 60000);
        window.addEventListener('focus', focus);
        return () => { active.current = false; epoch.current++; clearInterval(timer); window.removeEventListener('focus', focus); };
    }, [endpoint, retry]);
    async function save(selection: Selection, remove = false) {
        const c = verified.current;
        if (!c?.canWrite || mutation.current)
            return;
        mutation.current = true;
        setBusy(true);
        setError('');
        const attempt = epoch.current;
        if (!remove) {
            setPending(selection);
            try {
                sessionStorage.setItem(key(c.subject), JSON.stringify(selection));
            }
            catch { }
        }
        try {
            const response = await fetch(endpoint, { method: remove ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(remove ? { pageId: selection.pageId, subject: c.subject } : { ...selection, subject: c.subject }), signal: AbortSignal.timeout(10000) });
            if (!response.ok) {
                const data = await response.json();
                throw Error(data.error ?? 'Unable to save document link.');
            }
            if (!active.current || attempt !== epoch.current || verified.current?.subject !== c.subject)
                return;
            checks.current++;
            if (remove) {
                setContext(v => v ? { ...v, links: v.links.filter(l => l.pageId !== selection.pageId) } : v);
                setFrame('');
            }
            else {
                try {
                    sessionStorage.removeItem(key(c.subject));
                }
                catch { }
                setPending(null);
                setPicker('');
                setFrame(selection.pageId);
                setContext(v => v ? { ...v, defaultSpaceId: selection.setDefault || !v.defaultSpaceId ? selection.spaceId : v.defaultSpaceId, links: v.links.some(l => l.pageId === selection.pageId) ? v.links : [...v.links, { pageId: selection.pageId }] } : v);
            }
        }
        catch (e) {
            if (active.current && attempt === epoch.current)
                setError(`${e instanceof Error ? e.message : 'Unable to save.'}${!remove ? ' The page remains in Holy Sheet. Retry saving this link.' : ''}`);
        }
        finally {
            mutation.current = false;
            if (active.current)
                setBusy(false);
        }
    }
    const saveRef = useRef(save);
    saveRef.current = save;
    useEffect(() => {
        const receive = (event: MessageEvent) => {
            const c = verified.current, data = event.data;
            if (!c || event.origin !== c.origin || event.source !== iframe.current?.contentWindow || !data || data.type !== 'hs-document-selected' || data.channel !== channel.current || data.subject !== c.subject || !uuid.test(data.pageId) || typeof data.spaceId !== 'string' || data.spaceId.length > 200 || typeof data.created !== 'boolean')
                return;
            void saveRef.current({ pageId: data.pageId, spaceId: data.spaceId, created: data.created, setDefault: data.setDefault === true });
        };
        window.addEventListener('message', receive);
        return () => window.removeEventListener('message', receive);
    }, []);
    if (!visible)
        return null;
    return <section aria-label="Holy Sheet documents" className="card" style={{ marginTop: 16, padding: 16 }}><h3>Holy Sheet documents</h3><p className="sub">Pages keep their Holy Sheet permissions. Removing a link keeps the page.</p>
 {error && <p role="alert">{error}</p>}
 <button className="btn ghost" disabled={busy} onClick={() => setRetry(n => n + 1)}>Check access again</button>
 {context?.canWrite && (['create', 'link'] as const).map(mode => <button key={mode} className="btn" disabled={busy || !!pending} onClick={() => {
                channel.current = crypto.randomUUID();
                const hash = new URLSearchParams({ 'hs-user': context.subject, 'hs-channel': channel.current, 'hs-mode': mode, 'hs-host': context.hostOrigin??'https://sheethappensofficer.aplyd.org' });
                if (context.defaultSpaceId)
                    hash.set('hs-space', context.defaultSpaceId);
                setFrame('');
                setPicker(`${context.origin}/embed/picker#${hash}`);
            }}>{mode === 'create' ? 'Create page' : 'Link existing page'}</button>)}
 {pending && <p>A page is waiting to be linked. <button disabled={busy || !context?.canWrite} onClick={() => void save(pending)}>Retry saving link</button></p>}
 <ul>{context?.links.map(({ pageId }, i) => <li key={pageId}><button className="btn ghost" disabled={busy} onClick={() => { setPicker(''); setFrame(pageId); }}>Document {i + 1}</button> <a href={`${context.origin}/pages/${pageId}`} target="_blank" rel="noopener noreferrer">Open in Holy Sheet</a> {context.canWrite && <button className="btn ghost" disabled={busy} onClick={() => void save({ pageId, spaceId: '', created: false }, true)}>Remove link</button>}</li>)}</ul>
 {(picker || frame) && <><button className="btn ghost" disabled={busy} onClick={() => { setPicker(''); setFrame(''); }}>Close document</button>{picker ? <iframe ref={iframe} key={picker} title={picker ? 'Choose Holy Sheet page' : 'Holy Sheet document'} src={picker} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" style={{ width: '100%', height: '70vh', border: '1px solid var(--border)' }}/> : <HolySheetEditor key={frame} pageId={frame} viewContext="embedded" sessionProvider={provider}/>}</>}
 </section>;
}
