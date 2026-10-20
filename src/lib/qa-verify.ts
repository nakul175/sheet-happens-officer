// APL-2925. Staging only: mark a QA pool alias verified so tests/e2e/tools/provision-aliases.ts does not wait on an emailed link.
// Off unless the server sets QA_VERIFY_ALIASES=1, and refused on a production APP_URL even then: anywhere else it answers 404.
// Guarded by the server's JOB_SECRET, sent as X-Job-Secret because Authorization carries staging's basic-auth gate.
// Only the fixed pool addresses (tests/e2e/helpers/alias-pool.ts) can be verified. It never signs anyone up or in.
import { audit } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { jobSecretMatches } from "@/lib/jobs";

/** The Super Admin alias and nakul17+zz-qa-<slot>-<1..3>, slot 01-20, serial or local. */
export const POOL_ALIAS = /^nakul17\+zz-(?:sa|qa-(?:0[1-9]|1\d|20|serial|local)-[1-3])@aplyd\.com$/;

const PRODUCTION_HOSTS = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com", "168.144.144.69"]);

/** QA_VERIFY_ALIASES=1 and an APP_URL that parses and is not production. Anything else is off. */
export function qaVerifyEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.QA_VERIFY_ALIASES !== "1") return false;
  let host: string;
  try { host = new URL(env.APP_URL ?? "").hostname.toLowerCase().replace(/\.$/, ""); } catch { return false; }
  return !PRODUCTION_HOSTS.has(host);
}

export async function verifyPoolAlias(email: unknown, givenSecret: string, env: Record<string, string | undefined> = process.env) {
  if (!qaVerifyEnabled(env)) throw new ApiError(404, "Not found");
  if (!jobSecretMatches(givenSecret, env.JOB_SECRET ?? "")) throw new ApiError(401, "Not allowed");
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!POOL_ALIAS.test(address)) throw new ApiError(400, "Only a QA pool alias can be verified here");
  const user = await db.user.findUnique({ where: { email: address }, select: { id: true, emailVerifiedAt: true } });
  if (!user) throw new ApiError(404, "No account for this alias. Sign it up first.");
  if (user.emailVerifiedAt) return { status: "already-verified" as const };
  const now = new Date();
  await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
  // The emailed links are spent too, so nothing left in the inbox still works.
  await db.authToken.updateMany({ where: { userId: user.id, type: "VERIFY", usedAt: null }, data: { usedAt: now } });
  await audit("EMAIL_VERIFIED", { actorId: user.id, data: { via: "qa-verify-alias" } });
  return { status: "verified" as const };
}
