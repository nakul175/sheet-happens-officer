#!/usr/bin/env node
// CI tier — THE RUNTIME TWIN OF THE BOOT GATE: DOES THIS CANDIDATE SERVE ITS OWN PAGES?
//
// scripts/ci/router-root.test.mjs (commit 22360be) refuses a repo-root app/ by reading the filesystem, and
// scripts/ci/boot-probe.sh asks one URL for one status code. Neither says what this packet asks: did the server that
// is running actually SERVE the app — a page with our title, and a health body that names a release — or did
// something else answer 200? In the incident those gates were built for, GET / and GET /api/health both answered 404
// while the offline suite stayed green (commit 7dd3581 undid the cause). A probe that only ever sees 200 proves
// nothing; this one checks both routes in one run and fails differently for each kind of failure.
//
//   node scripts/ci/boot-check.mjs http://localhost:3264
//   node scripts/ci/boot-check.mjs http://localhost:3100 --timeout-ms 30000
//
// It asks, in this order, and stops at the first failure:
//   1. GET /              must be 200 AND render this app (a branded page title, or the sign-in form). A framework
//                         404 page ("404: This page could not be found.") or an empty body is not the app.
//   2. GET /api/health    must be 200 AND its JSON must carry a release/version field, and must not say ok=false.
//
// Exit codes — one per failure, because "it failed" is not a diagnosis:
//   0   both routes served (the only pass)
//   1   usage: no URL, an unparseable URL, a non-http(s) scheme, a bad --timeout-ms
//   10  unreachable: nothing answered (connection refused, DNS failure, timeout). Not a 404 — no server was there.
//   20  GET / answered, but not 200
//   21  GET / answered 200, but the body is not this app (no branded title, no sign-in form)
//   30  GET /api/health answered, but not 200
//   31  GET /api/health answered 200, but the body is not a health body (not JSON, no release/version, or ok=false)
//
// What it does not do, on purpose: it starts no server, spawns nothing, opens no database connection, reads no env
// file and sends no credential. It is a client of whatever is already listening, so it is safe to run anywhere a URL
// is reachable — and it can only ever prove what that server chose to answer.
//
// What a pass does NOT prove is written down in app/sho-status-plan/execution/W110-REPORT.md: a 200 from `next dev` is
// not a built release, and this probe is not Linux acceptance.

export const EXIT = {
  pass: 0,
  usage: 1,
  unreachable: 10,
  rootStatus: 20,
  rootBody: 21,
  healthStatus: 30,
  healthBody: 31,
};

const BRAND = "Sheet Happens Officer";
/** A page title of this app: "<Page> · Sheet Happens Officer". The framework 404's title is bare, so it misses. */
const BRANDED_TITLE = new RegExp(`<title[^>]*>[^<]*·[^<]*${BRAND}[^<]*</title>`, "i");
const PASSWORD_INPUT = /<input[^>]*type="password"/i;
const EMAIL_INPUT = /<input[^>]*name="email"/i;

/** The sign-in page is an accepted answer for `/`, so a route that sends a signed-out visitor there still passes. */
export function looksLikeApp(html) {
  return BRANDED_TITLE.test(html) || (PASSWORD_INPUT.test(html) && EMAIL_INPUT.test(html));
}

/**
 * Why a 200 from /api/health is not yet a health body. Returns null when the body is acceptable.
 * The field must be PRESENT; a null value passes but is reported, because `/api/health` sends
 * `{ ok, release: process.env.RELEASE ?? null }` and `next dev` has no RELEASE: the key proves the route was built,
 * not that this process identifies a release. Saying otherwise would make the probe fail on a working server.
 */
export function healthProblem(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "the body is not a JSON object";
  }
  const field = ["release", "version"].find((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (field === undefined) {
    return 'the JSON has neither a "release" nor a "version" field';
  }
  if (body.ok === false) {
    return "the JSON says ok=false, so the app reports itself unhealthy";
  }
  return null;
}

/** The value that names the release, for the summary line. */
export function releaseLabel(body) {
  const field = ["release", "version"].find((key) => Object.prototype.hasOwnProperty.call(body, key));
  const value = field === undefined ? undefined : body[field];
  return { field, value, nullValue: value === null || value === undefined || value === "" };
}


function usage() {
  console.error("usage: boot-check.mjs <base-url> [--timeout-ms <ms>]");
  console.error("  asks GET / and GET /api/health at <base-url>'s origin; starts no server and needs no database.");
  process.exit(EXIT.usage);
}

function parseArgs(argv) {
  const args = { base: null, timeoutMs: 10_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--timeout-ms") {
      const raw = argv[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) === 0) usage();
      args.timeoutMs = Number(raw);
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) usage();
    if (args.base !== null) usage();
    args.base = arg;
  }
  if (args.base === null || args.base.trim() === "") usage();
  return args;
}

/** One GET, with the response body as text. A throw is "nothing answered", which the caller maps to exit 10. */
async function get(url, timeoutMs) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "sho-boot-check/1" },
  });
  const text = await response.text();
  return { status: response.status, text, redirected: response.redirected, finalUrl: response.url };
}

/** Describe a fetch failure without inventing a status: the code the runtime gave, or the timeout. */
function unreachableReason(error) {
  if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "the request timed out";
  }
  // fetch() reports the transport failure on `cause` ("bad port", ECONNREFUSED, ENOTFOUND); the outer message is
  // always the opaque "fetch failed". Prefer the cause, so a failure line says which one it was.
  const cause = error && error.cause;
  const detail = (cause && (cause.code || cause.message)) || (error && error.message) || String(error);
  return `nothing answered (${detail})`;
}

function fail(code, message) {
  console.error("");
  console.error(`BOOT-CHECK FAIL (exit ${code}): ${message}`);
  process.exit(code);
}

async function main() {
  const { base, timeoutMs } = parseArgs(process.argv.slice(2));

  let origin;
  try {
    origin = new URL(base);
  } catch {
    usage();
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") usage();
  if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    // This probe asks `/` and `/api/health` at an ORIGIN. A caller who passes ".../app" means a prefix, and quietly
    // dropping it would probe a different path than the one they named - a false pass is worse than a usage error.
    console.error("boot-check: pass the origin only, e.g. http://localhost:3100 - a path, query or fragment is not a route prefix this probe understands.");
    process.exit(EXIT.usage);
  }

  const rootUrl = new URL("/", origin).href;
  const healthUrl = new URL("/api/health", origin).href;

  console.log(`boot-check: ${origin.origin} (GET / then GET /api/health; no server started, no database, timeout ${timeoutMs}ms)`);

  // 1. GET / — the page. A 200 here is what the router-root incident stopped producing.
  let root;
  try {
    root = await get(rootUrl, timeoutMs);
  } catch (error) {
    console.error(`  GET /                    unreachable`);
    fail(EXIT.unreachable, `GET ${rootUrl} ${unreachableReason(error)}`);
  }
  if (root.status !== 200) {
    console.error(`  GET /                    ${root.status}`);
    fail(
      EXIT.rootStatus,
      `GET ${rootUrl} returned ${root.status}, expected 200. Every route answers 404 when the App Router resolves to a shadowing repo-root app/ (commit 7dd3581 fixed exactly that).`,
    );
  }
  if (!looksLikeApp(root.text)) {
    console.error(`  GET /                    200 (but not this app)`);
    fail(
      EXIT.rootBody,
      `GET ${rootUrl} returned 200 but the body is not this app: no "${BRAND}" page title and no sign-in form (${root.text.length} bytes). A page that is not ours answering 200 is not a booted candidate.`,
    );
  }
  const title = (root.text.match(/<title[^>]*>([^<]*)<\/title>/i) || [, "(no title)"])[1].trim();
  const hop = root.redirected ? ` (redirected to ${new URL(root.finalUrl).pathname})` : "";
  console.log(`  GET /                    200 title="${title}"${hop}`);

  // 2. GET /api/health — the machine answer, and the release identity the deploy script reads.
  let health;
  try {
    health = await get(healthUrl, timeoutMs);
  } catch (error) {
    console.error(`  GET /api/health          unreachable`);
    fail(EXIT.unreachable, `GET ${healthUrl} ${unreachableReason(error)}`);
  }
  if (health.status !== 200) {
    console.error(`  GET /api/health          ${health.status}`);
    fail(
      EXIT.healthStatus,
      `GET ${healthUrl} returned ${health.status}, expected 200. The route answers 503 when the app cannot reach its database, so a non-200 here means the app is up but not healthy.`,
    );
  }

  let body;
  try {
    body = JSON.parse(health.text);
  } catch {
    body = undefined;
  }
  const problem = healthProblem(body);
  if (problem !== null) {
    console.error(`  GET /api/health          200 (but not a health body)`);
    const shownBody = health.text.slice(0, 200).replace(/\s+/g, " ");
    fail(EXIT.healthBody, `GET ${healthUrl} returned 200 but ${problem}. Body (first 200 chars): ${shownBody}`);
  }
  const release = releaseLabel(body);
  const shown = release.value === null ? "null" : JSON.stringify(release.value);
  console.log(`  GET /api/health          200 ok=${body.ok ?? "(unset)"} ${release.field}=${shown}`);
  if (release.nullValue) {
    // Not a failure: the route is built and answering. It is a fact about this process, and the report says so.
    console.log(`  note: ${release.field} is empty - this server identifies no release (RELEASE is unset).`);
  }

  console.log(`BOOT-CHECK PASS: / and /api/health served by ${origin.origin}`);
  process.exit(EXIT.pass);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
