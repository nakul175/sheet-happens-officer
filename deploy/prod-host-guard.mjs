// Stop tests and seed data from running against production unless the run is the
// read-only smoke. NJ's tag is exactly @readonly, with @write excluded exactly.
// ZZ-TEST seeding is refused against production in every case.
import { pathToFileURL } from "node:url";

const PROD_APP_HOSTS = new Set([
  "app.sheethappensofficer.com",
  "sheethappensofficer.com",
  "www.sheethappensofficer.com",
]);

function hostname(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function identity(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase();
    if (!url.hostname || !database) return null;
    return { host: url.hostname.toLowerCase(), database };
  } catch {
    return null;
  }
}

export function productionTarget(env = process.env) {
  const prodHost = (env.PROD_DB_HOST || "").trim().toLowerCase();
  const prodName = (env.PROD_DB_NAME || "").trim().toLowerCase();
  if (!prodHost || !prodName) {
    throw new Error("PROD_DB_HOST and PROD_DB_NAME must be set");
  }
  const hosts = [env.TASKBOARD_URL, env.APP_URL, env.BASE_URL, env.PLAYWRIGHT_TEST_BASE_URL]
    .map(hostname)
    .filter(Boolean);
  if (hosts.some((host) => PROD_APP_HOSTS.has(host))) return true;
  return [env.DATABASE_URL, env.DIRECT_DATABASE_URL].some((raw) => {
    const id = identity(raw);
    return id !== null && id.host === prodHost && id.database === prodName;
  });
}

function flagValues(argv, name) {
  const values = [];
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) values.push(argv[i + 1] ?? "");
    else if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
  }
  return values;
}

export function readonlySmoke(argv) {
  const grep = flagValues(argv, "--grep");
  const invert = flagValues(argv, "--grep-invert");
  return grep.length === 1 && grep[0] === "@readonly" && invert.length === 1 && invert[0] === "@write";
}

export function zzTestRequested(env = process.env, argv = []) {
  const blob = [env.ZZ_PREFIX, env.SEED_LABEL, env.SEED_NAME, ...argv].filter(Boolean).join("\n");
  return /ZZ-TEST/.test(blob);
}

export function assertProdHostGuard(argv = process.argv, env = process.env) {
  if (!productionTarget(env)) return;
  if (zzTestRequested(env, argv)) {
    throw new Error("refusing ZZ-TEST seeding against production");
  }
  if (!readonlySmoke(argv)) {
    throw new Error("refusing to run against production without --grep @readonly and --grep-invert @write");
  }
}

export function assertProdSeed(env = process.env, label = "") {
  if (!productionTarget(env)) return;
  if (/ZZ-TEST/.test(label) || zzTestRequested(env, [])) {
    throw new Error("refusing ZZ-TEST seeding against production");
  }
  throw new Error("refusing to seed against production");
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  try {
    if (process.argv.includes("--seed")) assertProdSeed(process.env, process.argv.join(" "));
    else assertProdHostGuard(process.argv, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "refusing to run against production");
    process.exit(1);
  }
}
