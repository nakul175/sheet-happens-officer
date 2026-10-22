// APL-2590: the "Seed APL-2590 fixtures (pr slots only)" step in staging-e2e.yml. Pam FAIL #146 @cd4135f D1-D3 and @1c3c901 D1-D4.
// Runs the step's own shell, read from the workflow, with npm and npx stubbed: no DB, no network, no dispatch.
// Pam left no qa:TC id for these; each title says "qa:TC missing".
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(path.join(process.cwd(), ".github/workflows/staging-e2e.yml"), "utf8");
const PW = "s3cretDbPw9";
const QA = "qaPass12345";
const HOST = "private-sho-db-do-user-45345612-0.k.db.ondigitalocean.com";
const url = (query: string, db = "sho_staging", host = HOST) => `postgresql://sho_pr_user:${PW}@${host}:25060/${db}${query}`;

/** The `run: |` block of the named step, dedented. */
function stepRun(name: string): string {
  const lines = WORKFLOW.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(at, name).toBeGreaterThan(-1);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  const body: string[] = [];
  let indent = -1;
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() === "") { body.push(""); continue; }
    const n = line.length - line.trimStart().length;
    if (indent < 0) indent = n;
    if (n < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const SCRIPT = stepRun("Seed APL-2590 fixtures (pr slots only)");
const dir = mkdtempSync(path.join(tmpdir(), "seed-step-"));
const bin = path.join(dir, "bin");
const withScript = path.join(dir, "with");
const withoutScript = path.join(dir, "without");
for (const d of [bin, path.join(withScript, "scripts"), withoutScript]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(withScript, "scripts/seed-apl2590-fixtures.ts"), "");
writeFileSync(path.join(dir, "step.sh"), SCRIPT);
// npm reports whether it can see either secret (Pam @1c3c901 D2); it never prints a value.
writeFileSync(path.join(bin, "npm"), "#!/bin/sh\necho \"STUB npm $* url=${SEED_DATABASE_URL:+SET} qa=${SHO_QA_PASS:+SET}\"\n");
writeFileSync(path.join(bin, "npx"), "#!/bin/sh\necho \"STUB npx $* SEED_TARGET=$SEED_TARGET SEED_PR_SLOT=$SEED_PR_SLOT\"\n");
chmodSync(path.join(bin, "npm"), 0o755);
chmodSync(path.join(bin, "npx"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function step(target: string, dbUrl: string, opts: { script?: boolean; qa?: string; nodeEnv?: string } = {}) {
  const r = spawnSync("bash", [path.join(dir, "step.sh")], {
    cwd: opts.script === false ? withoutScript : withScript,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, TARGET: target, SEED_DATABASE_URL: dbUrl, SHO_QA_PASS: opts.qa ?? QA, NODE_ENV: (opts.nodeEnv ?? "test") as NodeJS.ProcessEnv["NODE_ENV"] },
  });
  // ::add-mask:: lines are the runner's masking commands; GitHub never shows them. Everything else is log output.
  const raw = `${r.stdout}${r.stderr}`;
  const out = raw.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
  return { status: r.status, raw, out, seeded: out.includes("STUB npx tsx scripts/seed-apl2590-fixtures.ts") };
}

const pr = (n: number) => `pr${n}.staging.sheethappensofficer.com`;
/** A URL with a raw authority (host[:port][,host...]) and DB name, for the allowlist cases. */
const raw = (authority: string, db = "sho_staging", query = "?schema=sho_pr8") => `postgresql://sho_pr_user:${PW}@${authority}/${db}${query}`;

describe("qa:TC missing APL-2590 seed step (staging-e2e.yml)", () => {
  it("qa:TC missing D1: each pr slot seeds only with its own ?schema=sho_pr<N>", () => {
    for (const n of [1, 5, 8]) {
      const r = step(pr(n), url(`?schema=sho_pr${n}&sslmode=require`));
      expect(r.status, `pr${n}: ${r.out}`).toBe(0);
      expect(r.out).toContain(`SEED_TARGET=staging SEED_PR_SLOT=pr${n}`);
    }
  });

  it("qa:TC missing D1: a missing, public, other slot's, repeated or look-alike schema is refused", () => {
    const bad = [
      "", "?sslmode=require", "?schema=public", "?schema=", "?schema=sho_pr5", "?schema=SHO_PR8", "?schema=sho_pr8x",
      "?schema=sho_pr8&schema=public", "?schema=public&schema=sho_pr8", "?schema=sho_staging", "?SCHEMA=sho_pr8", "?Schema=sho_pr8",
    ];
    // Prisma reads the schema key case-sensitively; any other spelling falls back to public (Toby, #146@12fd2d6).
    const upper = new Set(["?SCHEMA=sho_pr8", "?Schema=sho_pr8"]);
    for (const q of bad) {
      const r = step(pr(8), url(q));
      expect(r.status, q || "(no query)").toBe(1);
      expect(r.out, q).toContain(upper.has(q) ? "must spell the schema key in lower case" : "must set ?schema=sho_pr8 (exactly once) for pr8");
      expect(r.seeded).toBe(false);
    }
  });

  it("qa:TC missing D2: host, hostaddr, dbname and options overrides in the query are refused, in any case", () => {
    for (const q of ["?host=10.0.0.9", "?schema=sho_pr8&host=/var/run/postgresql", "?HostAddr=139.59.45.166&schema=sho_pr8",
      "?schema=sho_pr8&dbname=defaultdb", "?schema=sho_pr8&options=-c%20search_path%3Dpublic", "?schema=sho_pr8&ho%73t=x"]) {
      const r = step(pr(8), url(q));
      expect(r.status, q).toBe(1);
      expect(r.out).toContain("overrides the host, DB name or search path");
      expect(r.seeded).toBe(false);
    }
    // A query with no path still reaches the check: the host part stops at "?".
    const r = step(pr(8), `postgresql://u:${PW}@${HOST}?host=10.0.0.9`);
    expect(r.status).toBe(1);
    expect(r.seeded).toBe(false);
  });

  it("qa:TC missing D3: a missing seed script fails the step, after the guards pass", () => {
    const r = step(pr(8), url("?schema=sho_pr8"), { script: false });
    expect(r.status).toBe(1);
    expect(r.out).toContain("::error::scripts/seed-apl2590-fixtures.ts is not on this ref");
    expect(r.out).not.toContain("STUB npm");
    expect(r.seeded).toBe(false);
  });

  it("qa:TC missing: staging, production, placeholder, prod DB hosts, defaultdb and a missing SHO_QA_PASS are refused", () => {
    const good = url("?schema=sho_pr8");
    const cases: [string, string, string | undefined][] = [
      ["staging.sheethappensofficer.com", good, undefined],
      ["app.sheethappensofficer.com", good, undefined],
      ["sheethappensofficer.aplyd.org", good, undefined],
      [pr(9), good, undefined],
      [pr(8), "", undefined],
      [pr(8), "postgresql://unused:unused@127.0.0.1:1/unused", undefined],
      [pr(8), url("?schema=sho_pr8", "sho_staging", "localhost"), undefined],
      ...["139.59.45.166", "sho.139-59-45-166.sslip.io", "168.144.144.69", "APP.sheethappensofficer.com.", "sheethappensofficer.aplyd.org"]
        .map((h): [string, string, undefined] => [pr(8), url("?schema=sho_pr8", "sho_staging", h), undefined]),
      [pr(8), url("?schema=sho_pr8", "defaultdb"), undefined],
      [pr(8), good, ""],
    ];
    for (const [target, dbUrl, qa] of cases) {
      const r = step(target, dbUrl, { qa });
      expect(r.status, `${target} ${dbUrl.replace(PW, "***")}`).toBe(1);
      expect(r.out).toContain("::error::");
      expect(r.seeded).toBe(false);
    }
  });

  it("qa:TC missing D1 (@1c3c901): only the exact staging DB host is allowed, with or without a port", () => {
    for (const authority of [`${HOST}:25060`, HOST, `${HOST.toUpperCase()}:25060`, `${HOST}.:25060`]) {
      const r = step(pr(8), raw(authority));
      expect(r.status, `${authority}: ${r.out}`).toBe(0);
      expect(r.seeded).toBe(true);
    }
  });

  it("qa:TC missing D1 (@1c3c901): multi-host, decimal IP, sslip/nip, ::ffff:, prod domain, 0.0.0.0 and 127.1 hosts are refused", () => {
    const refused: [string, string][] = [
      ["multi-host", `${HOST}:25060,evil.example:5432`],
      ["multi-host", `${HOST}:25060,evil.example`],
      ["multi-host", `evil.example:5432,${HOST}:25060`],
      ["multi-host", `${HOST},evil.example`],
      ["decimal IP", "2335911334:25060"],
      ["decimal IP", "2130706433"],
      ["sslip", "sho.139-59-45-166.sslip.io:5432"],
      ["sslip", `10-0-0-1.sslip.io`],
      ["nip", "127.0.0.1.nip.io:5432"],
      ["nip", `${HOST}.nip.io:25060`],
      ["::ffff:", "[::ffff:127.0.0.1]:5432"],
      ["::ffff:", "[::ffff:8b3b:2da6]:5432"],
      ["prod domain", "sheethappensofficer.com:5432"],
      ["prod domain", "www.sheethappensofficer.com"],
      ["prod domain", "app.sheethappensofficer.com:5432"],
      ["prod domain", "sheethappensofficer.aplyd.org:5432"],
      ["prod IP", "139.59.45.166:5432"],
      ["prod IP", "168.144.144.69:5432"],
      ["0.0.0.0", "0.0.0.0:5432"],
      ["127.1", "127.1:5432"],
      ["look-alike", `${HOST}.evil.example:25060`],
      ["look-alike", `x${HOST}:25060`],
      ["bad port", `${HOST}:25060x`],
    ];
    for (const [kind, authority] of refused) {
      const r = step(pr(8), raw(authority));
      expect(r.status, `${kind} ${authority}`).toBe(1);
      expect(r.out, `${kind} ${authority}`).toContain("host is not the staging DB host");
      expect(r.seeded).toBe(false);
    }
  });

  it("qa:TC missing D1 (@1c3c901): only the sho_staging DB name is allowed", () => {
    for (const db of ["sho_production", "postgres", "defaultdb", "SHO_STAGING", "sho_staging2", "sho_pr8", ""]) {
      const r = step(pr(8), raw(`${HOST}:25060`, db));
      expect(r.status, db || "(none)").toBe(1);
      expect(r.out, db).toContain("DB name is not sho_staging");
      expect(r.seeded).toBe(false);
    }
  });

  it("qa:TC missing D2 (@1c3c901): npm ci runs without SEED_DATABASE_URL and SHO_QA_PASS in its env", () => {
    expect(SCRIPT).toContain("env -u SEED_DATABASE_URL -u SHO_QA_PASS npm ci");
    const r = step(pr(8), url("?schema=sho_pr8"));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("STUB npm ci url= qa=");
    expect(r.out).not.toContain("url=SET");
    expect(r.out).not.toContain("qa=SET");
    expect(r.seeded).toBe(true);
  });

  it("qa:TC missing D3 (@1c3c901): a line break in either secret is refused, and every line is masked first", () => {
    const good = url("?schema=sho_pr8");
    const cases: [string, string, string[]][] = [
      [`${good}\nhost=evil.example`, QA, [good, "host=evil.example"]],
      [`${good}\r\npostgresql://x:y@evil.example/sho_staging`, QA, [good, "postgresql://x:y@evil.example/sho_staging"]],
      [`${good}\r`, QA, [good]],
      [`postgresql://u:${PW}@evil.example:5432/sho_staging\n${good}`, QA, [`postgresql://u:${PW}@evil.example:5432/sho_staging`, good]],
      [good, "qaPass\n12345", ["qaPass", "12345"]],
    ];
    for (const [dbUrl, qa, lines] of cases) {
      const r = step(pr(8), dbUrl, { qa });
      expect(r.status, JSON.stringify(dbUrl.replace(PW, "***"))).toBe(1);
      expect(r.out).toContain("contains a line break");
      expect(r.seeded).toBe(false);
      expect(r.out).not.toContain("STUB npm");
      for (const line of lines) expect(r.raw, line.replace(PW, "***")).toContain(`::add-mask::${line}\n`);
      expect(r.out).not.toContain(PW);
    }
  });

  it("qa:TC missing D4 (@1c3c901): NODE_ENV=production refuses the seed", () => {
    for (const nodeEnv of ["production", "Production", "PRODUCTION"]) {
      const r = step(pr(8), url("?schema=sho_pr8"), { nodeEnv });
      expect(r.status, nodeEnv).toBe(1);
      expect(r.out).toContain("::error::NODE_ENV=production. Refusing to seed.");
      expect(r.out).not.toContain("STUB npm");
      expect(r.seeded).toBe(false);
    }
    expect(step(pr(8), url("?schema=sho_pr8"), { nodeEnv: "test" }).seeded).toBe(true);
  });

  it("qa:TC missing: the step never prints the DB password or SHO_QA_PASS, and has no set -x or env dump", () => {
    const runs = [step(pr(8), url("?schema=sho_pr8")), step(pr(8), url("?schema=public")), step(pr(8), url("?host=x"))];
    for (const r of runs) {
      expect(r.out).not.toContain(PW);
      expect(r.out).not.toContain(QA);
    }
    const code = SCRIPT.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/set -x|set -o xtrace|printenv|^\s*env\s*$|declare -p/m);
    expect(SCRIPT).toContain('echo "::add-mask::$url"');
  });

  it("qa:TC missing: the step runs only when the target check marks a pr slot", () => {
    expect(WORKFLOW).toMatch(/- name: Seed APL-2590 fixtures \(pr slots only\)\n\s+if: steps\.target\.outputs\.pr_slot == 'true'/);
    const target = stepRun("Check the target host");
    const allow = WORKFLOW.match(/TARGET_ALLOWLIST: '([^']+)'/)?.[1] ?? "";
    for (const [host, slot] of [[pr(5), "true"], [pr(8), "true"], ["staging.sheethappensofficer.com", "false"]]) {
      const out = path.join(dir, `out-${host}`);
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-c", target], { encoding: "utf8", env: { PATH: process.env.PATH, TARGET: host, TARGET_ALLOWLIST: allow, GITHUB_OUTPUT: out, NODE_ENV: "test" } });
      expect(r.status, host).toBe(0);
      expect(readFileSync(out, "utf8"), host).toContain(`pr_slot=${slot}`);
    }
    for (const host of ["app.sheethappensofficer.com", "sheethappensofficer.com", pr(9)]) {
      const r = spawnSync("bash", ["-c", target], { encoding: "utf8", env: { PATH: process.env.PATH, TARGET: host, TARGET_ALLOWLIST: allow, GITHUB_OUTPUT: "/dev/null", NODE_ENV: "test" } });
      expect(r.status, host).toBe(1);
    }
  });
});
