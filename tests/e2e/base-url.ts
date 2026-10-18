// The APL-2522 spec calls this before its tests run.
// Vitest replaces the BASE_URL it was given with "/" before the spec file loads.
// The value from process start is still in the process image (on Linux, /proc/self/environ).
// TASKBOARD_URL and STAGING_URL are read from the live environment. The rewritten slot is not.
import { readFileSync } from "node:fs";

const PRODUCTION_HOSTS = new Set([
  "sheethappensofficer.com",
  "www.sheethappensofficer.com",
  "app.sheethappensofficer.com",
]);

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

function hostOf(raw: string | undefined): string | null {
  if (raw == null || raw === "") return null;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    const bare = raw.toLowerCase().replace(/\.$/, "");
    return bare === "/" ? null : bare;
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
