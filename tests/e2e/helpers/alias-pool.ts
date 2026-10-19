// APL-2748. The fixed set of verified nakul17+ aliases the story specs sign in as. Nothing here signs anyone up.
// Pure module: no Playwright import, so Vitest and the provisioning script load it too.
//
// Each CI job has its own slot, so two shards running at once never share a person (a spec may promote one
// to Admin, or read their bell). Shards are 01-20 (QA_SLOT = matrix.nn), the serial job is "serial", and a
// run on a laptop is "local". A slot holds PER_SLOT Members; the most any spec asks for in one cast is 3.
// The Super Admin (QA_ADMIN_EMAIL) is shared: it is listed in SUPER_ADMIN_EMAILS on the server and no spec
// changes its role. Every account uses the one password SHO_QA_PASS, which only CI or staging secrets hold.

/** Stable Super Admin address. The server lists it in SUPER_ADMIN_EMAILS. */
export const QA_ADMIN_EMAIL = "nakul17+zz-sa@aplyd.com";
export const QA_ADMIN_NAME = "ZZ-TEST QA Admin";
export const PER_SLOT = 3;
export const SHARD_SLOTS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, "0"));
export const SLOTS = [...SHARD_SLOTS, "serial", "local"] as const;

export type PoolPerson = { email: string; name: string; slot: string; index: number };

function checkSlot(slot: string) {
  if (!(SLOTS as readonly string[]).includes(slot)) throw new Error(`Unknown alias slot "${slot}". Use 01-20, serial or local.`);
}

/** One pool Member. `index` is 1-based. */
export function poolPerson(slot: string, index: number): PoolPerson {
  checkSlot(slot);
  if (!Number.isInteger(index) || index < 1 || index > PER_SLOT) throw new Error(`Alias index ${index} is outside 1-${PER_SLOT}.`);
  return { email: `nakul17+zz-qa-${slot}-${index}@aplyd.com`, name: `ZZ-TEST QA ${slot}-${index}`, slot, index };
}

/** Every Member in a slot, in index order. */
export function poolFor(slot: string): PoolPerson[] {
  return Array.from({ length: PER_SLOT }, (_, i) => poolPerson(slot, i + 1));
}

/** QA_SLOT, else "local". A set but unknown value fails rather than falling back to someone else's slot. */
export function slotFromEnv(env: Record<string, string | undefined>): string {
  const raw = (env.QA_SLOT ?? "").trim().toLowerCase();
  if (!raw) return "local";
  const slot = /^\d$/.test(raw) ? `0${raw}` : raw;
  checkSlot(slot);
  return slot;
}

/** "01,02,serial" or "all". Unknown slots throw. */
export function parseSlots(raw: string | undefined): string[] {
  if (!raw || raw.trim().toLowerCase() === "all") return [...SLOTS];
  const out = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => (/^\d$/.test(s) ? `0${s}` : s));
  out.forEach(checkSlot);
  return [...new Set(out)];
}

const PRODUCTION_HOSTS = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com", "168.144.144.69"]);
const ALLOWED_HOST = /^(staging\.sheethappensofficer\.com|pr[1-4]\.staging\.sheethappensofficer\.com|localhost|127\.0\.0\.1)$/;

/** The provisioning script's target. Staging, a pr1-pr4 preview or this machine; production and everything else are refused. */
export function provisionTarget(raw: string | undefined): URL {
  if (!raw) throw new Error("Set BASE_URL to the staging host (https://staging.sheethappensofficer.com). There is no default.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("BASE_URL is not a URL."); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (PRODUCTION_HOSTS.has(host)) throw new Error(`Refusing to provision aliases on production (${host}).`);
  if (!ALLOWED_HOST.test(host)) throw new Error(`Refusing host ${host}: only staging, pr1-pr4.staging or localhost.`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local && url.protocol !== "https:") throw new Error("Use https for a remote host.");
  return new URL(url.origin);
}

/** True when `text` carries none of the secrets. Use before printing any server text. */
export function freeOfSecrets(text: string, secrets: (string | undefined)[]) {
  return secrets.every((s) => !s || !text.includes(s));
}
