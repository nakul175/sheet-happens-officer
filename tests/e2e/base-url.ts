// The app under test. One place for it: playwright.config.ts and support.ts read it, specs and helpers import BASE_URL from ./support.
// BASE_URL wins; STAGING_URL is the older name and still works. Production hosts are refused whatever the variable says.
const PRODUCTION = ["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com"];

export const BASE_URL = (process.env.BASE_URL || process.env.STAGING_URL || "https://staging.sheethappensofficer.com").replace(/\/+$/, "");

const host = (() => { try { return new URL(BASE_URL).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; } })();
if (!host) throw new Error(`BASE_URL is not a URL: ${BASE_URL}`);
if (PRODUCTION.includes(host)) throw new Error(`Refusing to run story tests against production (${host}).`);
