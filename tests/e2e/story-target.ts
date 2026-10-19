// Import-time production refusal for the APL-2522 Playwright spec.
// tests/e2e/apl-2522-prod-guard.test.ts starts that spec in a child Vitest process
// and expects this refusal. Vitest rewrites the live BASE_URL to "/" before the
// spec loads, so the guard reads the value from process start (on Linux, /proc/self/environ).
// If that image cannot be read, the original value is hidden and the guard fails closed.
// TASKBOARD_URL and STAGING_URL are read from the live environment. The rewritten slot is not.
// This file is loaded before the Playwright helpers so the refusal prints even when
// those helpers cannot load. On this branch tests/e2e/base-url.ts is the Playwright
// URL constant, so the guard lives here.
import { readFileSync } from "node:fs";

const PRODUCTION_HOSTS = new Set([
  "sheethappensofficer.com",
  "www.sheethappensofficer.com",
  "app.sheethappensofficer.com",
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

assertStoryTargetAllowed();
