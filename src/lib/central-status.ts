import { holyQaIdentity, centralIdentitySecret, centralIdentityIssuer } from '@/lib/holy-qa-identity';
/** Live authority only; the returned native binding is never inferred from email. */
export async function centralIdentity(subject: string, uid: string): Promise<string | null> {
    try {
        const qa = holyQaIdentity();
        if (qa && !qa.subjects.includes(subject))
            return null;
        const issuer = process.env.APLYD_ACCOUNTS_ISSUER, secret = centralIdentitySecret();
        if (issuer !== centralIdentityIssuer())
            return null;
        const response = await fetch(`${issuer}/internal/session/status`, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: qa?.clientId ?? 'sho', client_secret: secret, sub: subject, uid }) });
        if (!response.ok)
            return null;
        const result = await response.json();
        return result.active === true && result.sub === subject && typeof result.local_id === 'string' && result.local_id.length > 0 && result.local_id.length <= 200 && !/[\u0000-\u0020\u007f]/.test(result.local_id) ? result.local_id : null;
    }
    catch {
        return null;
    }
}
export async function centralSessionActive(subject: string, uid: string, localId: string): Promise<boolean> { return await centralIdentity(subject, uid) === localId; }
