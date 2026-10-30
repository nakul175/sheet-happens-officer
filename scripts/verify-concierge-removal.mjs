import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Run after next build. This verifies the compiled router, not only source filenames.
const manifest = JSON.parse(readFileSync(".next/server/app-paths-manifest.json", "utf8"));
const retired = Object.keys(manifest).filter((route) => /(^|\/)(concierge|usage)(\/|$)/.test(route));
assert.deepEqual(retired, [], `Retired routes remain in build: ${retired.join(", ")}`);
for (const route of ["authorize", "token", "userinfo", "status"]) {
  assert.ok(manifest[`/api/suite/${route}/route`], `Suite route missing from build: ${route}`);
}
console.log("ROUTE_REMOVAL_PASS: retired routes=0; suite routes=4");
