/** Production SHO legacy session checks. No identity inference or role/session writes. */
export async function nativeSessionActive(localId: string, createdAt: Date): Promise<boolean> {
  if (process.env.APLYD_NATIVE_LOGOUT_ENABLED !== "true") return true;
  try {
    const issuedAt = createdAt.getTime();
    if (!localId || localId.length > 200 || !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Date.now()) return false;
    const issuer = process.env.APLYD_ACCOUNTS_ISSUER;
    const secret = process.env.APLYD_ACCOUNTS_CLIENT_SECRET;
    if (issuer !== "https://accounts.aplyd.org" || !secret || secret.length < 32) return false;
    const response = await fetch(`${issuer}/internal/native-session/status`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(4000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "sho", client_secret: secret, local_id: localId, mode: "check", issued_at_ms: issuedAt }),
    });
    if (!response.ok) return false;
    const proof = await response.json();
    return proof.local_id === localId && proof.active === true && typeof proof.managed === "boolean" &&
      (proof.managed ? Number.isSafeInteger(proof.generation) && proof.generation >= 0 : proof.generation === null);
  } catch { return false; }
}
