import * as client from "openid-client";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SHO_ORIGIN = "https://sheethappensofficer.aplyd.org";
export const CENTRAL_CALLBACK = SHO_ORIGIN + "/api/auth/aplyd/callback";
export const FLOW_COOKIE = "__Host-sho_oidc_flow";
export const flowCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 600 };
export type Flow = { state: string; nonce: string; verifier: string; expires: number; returnPath?: string };
function secret() {
  const value = process.env.APLYD_ACCOUNTS_CLIENT_SECRET;
  if (!value || value.length < 32) throw new Error("Central login not configured");
  return value;
}
export async function centralClient() {
  if (process.env.APLYD_ACCOUNTS_SSO !== "true" || process.env.APLYD_ACCOUNTS_ISSUER !== "https://accounts.aplyd.org") throw new Error("Central login disabled");
  const config = await client.discovery(new URL(process.env.APLYD_ACCOUNTS_ISSUER), "sho", secret(), client.ClientSecretBasic(secret()));
  config.timeout = 5;
  return config;
}
export function sealFlow(flow: Flow): string {
  const key = createHash("sha256").update(secret() + "/sho-oidc-flow").digest();
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(flow)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
export function readFlow(value: string): Flow {
  if (value.length > 4096) throw new Error("Invalid flow");
  const data = Buffer.from(value, "base64url");
  const key = createHash("sha256").update(secret() + "/sho-oidc-flow").digest();
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const flow = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  if (!Number.isFinite(flow.expires) || flow.expires < Date.now() || flow.expires > Date.now() + 600000 ||
      ![flow.state, flow.nonce, flow.verifier].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(v))) throw new Error("Invalid flow");
  return flow;
}
