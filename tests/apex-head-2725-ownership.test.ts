// SHO-2725 (APL-2661 AC1), the boundary. The app answers the apex and www names with a 301 for HEAD as well as GET
// (src/proxy.ts:52-60); tests/apex-head-2725.test.ts and tests/apex-head-2725-http.test.ts prove that. Neither can say
// whether a request for the apex ever reaches the app: those names are terminated in front of it, and the only edge
// config this repository writes serves a different name (`sheethappensofficer.aplyd.org`, deploy/cloud-init.yaml:39).
// So this file pins the part the repository does own, and fails the moment it starts owning the .com edge: at that
// point HEAD on the apex is ours to answer, and nothing here may answer 405.
// qa:TC missing: QA has not assigned TC ids for this story yet.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const CLOUD_INIT = "deploy/cloud-init.yaml";

/** The Caddyfile deploy/cloud-init.yaml writes at first boot, kept as written (its indentation matters). */
function caddyfile(): string[] {
  const lines = readFileSync(CLOUD_INIT, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "- path: /etc/sho/Caddyfile");
  expect(start, `${CLOUD_INIT} still writes /etc/sho/Caddyfile`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trimStart().startsWith("- ")) break; // the next write_files entry
    body.push(line);
  }
  return body;
}

/**
 * The names that Caddyfile claims. A site address sits at the content indent (exactly six spaces) and ends its line
 * with `{`; Caddy accepts several names on one line, separated by commas (`a.com, www.a.com {`), so the whole run is
 * split. Anything deeper belongs to a directive's block, not to the site address.
 */
const siteAddresses = (body: string[]) =>
  body.flatMap((line) => {
    const addresses = /^ {6}([^{]+?)\s*\{\s*$/.exec(line)?.[1];
    return addresses ? addresses.split(",").map((name) => name.trim()).filter(Boolean) : [];
  });

const APEX = /^(www\.)?sheethappensofficer\.com$/;

describe("SHO-2725 the apex is answered outside this repository, and that is pinned here", () => {
  it("the edge config this repo writes does not serve the apex or www, so the 405 there is not ours to answer", () => {
    const sites = siteAddresses(caddyfile());
    // Control: the parse reads the real file, so a new site block cannot slip past this test.
    expect(sites).toContain("sheethappensofficer.aplyd.org");
    // If this fails, this repository now terminates the .com names and must answer HEAD there itself (301, never 405).
    expect(sites.filter((site) => APEX.test(site)), `${CLOUD_INIT}:37-42`).toEqual([]);
  });

  it("no release script and no workflow installs a second edge, so a release cannot change what the apex answers", () => {
    const files = [
      ...readdirSync("deploy").map((name) => `deploy/${name}`),
      ...readdirSync(".github/workflows").map((name) => `.github/workflows/${name}`),
    ];
    // deploy/release.sh installs, migrates, builds and restarts the app; it never reloads or rewrites Caddy.
    expect(readFileSync("deploy/release.sh", "utf8")).not.toMatch(/caddy/i);
    // Exactly one edge config exists in this tree, and it is the one the first test reads.
    expect(files.filter((file) => /caddyfile/i.test(readFileSync(file, "utf8")))).toEqual([CLOUD_INIT]);
  });

  it("the app redirects the apex only when the edge forwards the name, so the forwarder is on the path", async () => {
    const direct = await proxy(new NextRequest("http://127.0.0.1:3270/", { method: "HEAD" }));
    // Raised as the droplet's IP (an uptime check, a job): this is the app, not the apex, and nothing here says 301.
    expect(direct.status).not.toBe(301);
    const forwarded = await proxy(new NextRequest("http://127.0.0.1:3270/", {
      method: "HEAD",
      headers: { "x-forwarded-host": "sheethappensofficer.com" },
    }));
    // The same request once the name arrives: 301, because src/proxy.ts:52-60 answers it before any handler runs.
    expect(forwarded.status).toBe(301);
    expect(forwarded.headers.get("location")).toBe("https://app.sheethappensofficer.com/");
  });
});
