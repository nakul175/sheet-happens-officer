export async function centralSessionActive(subject: string, uid: string, localId: string): Promise<boolean> {
  try {
    const issuer = process.env.APLYD_ACCOUNTS_ISSUER;
    const secret = process.env.APLYD_ACCOUNTS_CLIENT_SECRET;
    if (issuer !== "https://accounts.aplyd.org" || !secret || secret.length < 32) return false;
    const response = await fetch(`${issuer}/internal/session/status`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(4000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "sho", client_secret: secret, sub: subject, uid }),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.active === true && result.sub === subject && result.local_id === localId;
  } catch { return false; }
}
