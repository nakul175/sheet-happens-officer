// Story specs import this on startup and stop if the target is production.
// Vitest replaces the BASE_URL it was given with "/" before a spec file loads.
// The value from process start is still in the process image (on Linux, /proc/self/environ).
// TASKBOARD_URL and STAGING_URL are read from the live environment. The guard does not read the rewritten slot.
import { readFileSync } from "node:fs";

const PRODUCTION_HOSTS = new Set([
  "sheethappensofficer.com",
  "www.sheethappensofficer.com",
  "app.sheethappensofficer.com",
]);

const DEFAULT_BASE = "https://staging.sheethappensofficer.com";

/** BASE_URL as it was when this process started, before Vitest rewrote it to "/". */
export function baseUrlAtProcessStart(): string | undefined {
  if (process.platform === "linux") {
    try {
      const marker = "BASE_URL=";
      for (const entry of readFileSync("/proc/self/environ").toString("latin1").split("\0")) {
        if (!entry.startsWith(marker)) continue;
        const value = entry.slice(marker.length);
        return value === "" ? undefined : value;
      }
      return undefined;
    } catch {
      // The process image could not be read; fall through.
    }
  }
  // Playwright and other runners do not rewrite BASE_URL. Vitest does, and then this slot is "/".
  if (process.env.VITEST) return undefined;
  const current = process.env.BASE_URL;
  if (current == null || current === "" || current === "/") return undefined;
  return current;
}

function hostOf(label: string, raw: string | undefined): string | null {
  if (raw == null || raw === "" || raw === "/") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return host || null;
}

function refuseProduction(label: string, raw: string | undefined): void {
  const host = hostOf(label, raw);
  if (host && PRODUCTION_HOSTS.has(host)) {
    throw new Error(`Refusing to run story tests against production (${host}).`);
  }
}

/**
 * Refuses a production TASKBOARD_URL, STAGING_URL, or the BASE_URL this process was started with.
 * `baseUrl` defaults to that starting value. The env object's BASE_URL property is not consulted.
 */
export function assertStoryTargetAllowed(env: NodeJS.ProcessEnv = process.env, baseUrl: string | undefined = baseUrlAtProcessStart()): void {
  refuseProduction("TASKBOARD_URL", env.TASKBOARD_URL);
  refuseProduction("STAGING_URL", env.STAGING_URL);
  refuseProduction("BASE_URL", baseUrl);
}

assertStoryTargetAllowed();

function usable(raw: string | undefined): string | undefined {
  if (raw == null || raw === "" || raw === "/") return undefined;
  return raw.replace(/\/+$/, "");
}

export const BASE_URL = usable(baseUrlAtProcessStart()) || usable(process.env.STAGING_URL) || DEFAULT_BASE;
