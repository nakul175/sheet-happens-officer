// Playwright specs import BASE_URL from this module (via support.ts and playwright.config.ts).
// Vitest specs import assertStoryTargetAllowed. Vitest rewrites the live BASE_URL to "/"
// before a spec file loads, so the guard reads the value from process start and this module
// does not throw while Vitest is loading it.
// The value from process start is still in the process image (on Linux, /proc/self/environ).
// If that image cannot be read, the original value is hidden and the guard fails closed.
// TASKBOARD_URL and STAGING_URL are read from the live environment. The rewritten slot is not.
import { readFileSync } from "node:fs";

const PRODUCTION_HOSTS = new Set([
  "sheethappensofficer.com",
  "www.sheethappensofficer.com",
  "app.sheethappensofficer.com",
  "sheethappensofficer.aplyd.org",
  "168.144.144.69",
]);

const UNREADABLE = "Refusing to run: the starting BASE_URL could not be read.";

export type StartingBaseUrl = {
  platform: NodeJS.Platform;
  /** Process image, or null when it cannot be read. Ignored off Linux. */
  environ: Buffer | null;
  underVitest: boolean;
  liveBaseUrl: string | undefined;
};

function baseUrlFromEnviron(environ: Buffer): string | undefined {
  const marker = "BASE_URL=";
  for (const entry of environ.toString("latin1").split("\0")) {
    if (!entry.startsWith(marker)) continue;
    const value = entry.slice(marker.length);
    return value === "" ? undefined : value;
  }
  return undefined;
}

/**
 * BASE_URL as it was when the process started.
 * Throws, without quoting any value, when that original value cannot be known.
 * An absent BASE_URL in a readable process image is known: it was not set.
 */
export function startingBaseUrl(input: StartingBaseUrl): string | undefined {
  if (input.platform === "linux" && input.environ) {
    return baseUrlFromEnviron(input.environ);
  }
  if (!input.underVitest) {
    const current = input.liveBaseUrl;
    if (current == null || current === "" || current === "/") return undefined;
    return current;
  }
  throw new Error(UNREADABLE);
}

/** BASE_URL from process start. Vitest has already rewritten the live value to "/". */
export function baseUrlAtProcessStart(): string | undefined {
  let environ: Buffer | null = null;
  if (process.platform === "linux") {
    try {
      environ = readFileSync("/proc/self/environ");
    } catch {
      environ = null;
    }
  }
  return startingBaseUrl({
    platform: process.platform,
    environ,
    underVitest: Boolean(process.env.VITEST),
    liveBaseUrl: process.env.BASE_URL,
  });
}

function hostOf(raw: string | undefined): string | null {
  if (raw == null || raw === "" || raw === "/") return null;
  const candidate = raw.includes("://") ? raw : `http://${raw}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

function refuseProduction(raw: string | undefined): void {
  const host = hostOf(raw);
  if (host && PRODUCTION_HOSTS.has(host)) {
    throw new Error(`Refusing to run story tests against production (${host}).`);
  }
}

/**
 * Refuses a production TASKBOARD_URL, STAGING_URL, or the BASE_URL this process was started with.
 * `baseUrl` defaults to that starting value. The env object's BASE_URL property is not consulted.
 */
export function assertStoryTargetAllowed(env: NodeJS.ProcessEnv = process.env, baseUrl: string | undefined = baseUrlAtProcessStart()): void {
  refuseProduction(env.TASKBOARD_URL);
  refuseProduction(env.STAGING_URL);
  refuseProduction(baseUrl);
}

/** With no target variable set, the app under test is the local server. Staging is never a default (APL-2879 D1). */
export const LOCAL_DEFAULT = "http://localhost:3100";

/**
 * The app under test: BASE_URL, then TASKBOARD_URL (the local and CI name, as on main), then STAGING_URL (the older
 * staging name). With none set it is LOCAL_DEFAULT. A staging run must say so: staging-e2e.yml sets BASE_URL.
 * Production hosts are refused below whatever the variable says.
 */
/** Any environment-like object; only BASE_URL, TASKBOARD_URL and STAGING_URL are read. */
export type TargetEnv = Record<string, string | undefined>;

export function resolveBaseUrl(env: TargetEnv = process.env): string {
  return (env.BASE_URL || env.TASKBOARD_URL || env.STAGING_URL || LOCAL_DEFAULT).replace(/\/+$/, "");
}

export const BASE_URL = resolveBaseUrl();

if (!process.env.VITEST) {
  const host = hostOf(BASE_URL);
  if (!host) throw new Error(`BASE_URL is not a URL: ${BASE_URL}`);
  if (PRODUCTION_HOSTS.has(host)) throw new Error(`Refusing to run story tests against production (${host}).`);
}
