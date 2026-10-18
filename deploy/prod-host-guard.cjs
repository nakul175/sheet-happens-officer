// Stop tests and seed data from running against production unless the run is the
// read-only smoke. NJ's tag is exactly @readonly, with @write excluded exactly.
// This file is CommonJS on purpose. Playwright compiles an imported .mjs into
// CommonJS syntax and then evaluates it as ESM, which throws "exports is not defined"
// and rolls the production deploy back when the smoke starts.
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

function productionTarget(env = process.env) {
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

// Commander accepts `-gVALUE` and `-GVALUE` with no separator, and ORs extra greps.
// One `@readonly` grep and one `@write` grep-invert are allowed. A second grep, an
// attached value that is not that token, or any other option is refused.
// `--list` does not select tests; the harness uses it to prove Playwright can load this file.
function takeFlag(argv, index, arg, name) {
  if (arg === name) return { value: argv[index + 1] ?? "", index: index + 1 };
  const eq = `${name}=`;
  if (arg.startsWith(eq)) return { value: arg.slice(eq.length), index };
  if (name.length === 2 && arg.startsWith(name) && arg.length > name.length) {
    return { value: arg.slice(name.length), index };
  }
  return null;
}

function readonlySmoke(argv) {
  const greps = [];
  const inverts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") continue;
    if (!arg.startsWith("-") || arg === "-") continue;

    if (arg === "--grep-invert" || arg.startsWith("--grep-invert=")) {
      const taken = takeFlag(argv, i, arg, "--grep-invert");
      inverts.push(taken.value);
      i = taken.index;
      continue;
    }
    if (arg.startsWith("--grep")) {
      if (arg !== "--grep" && !arg.startsWith("--grep=")) return false;
      const taken = takeFlag(argv, i, arg, "--grep");
      greps.push(taken.value);
      i = taken.index;
      continue;
    }
    if (arg === "-g" || (arg.startsWith("-g") && !arg.startsWith("--"))) {
      const taken = takeFlag(argv, i, arg, "-g");
      greps.push(taken.value);
      i = taken.index;
      continue;
    }
    if (arg === "-G" || (arg.startsWith("-G") && !arg.startsWith("--"))) {
      const taken = takeFlag(argv, i, arg, "-G");
      inverts.push(taken.value);
      i = taken.index;
      continue;
    }
    return false;
  }
  return greps.length === 1 && greps[0] === "@readonly" && inverts.length === 1 && inverts[0] === "@write";
}

function zzTestRequested(env = process.env, argv = []) {
  const blob = [env.ZZ_PREFIX, env.SEED_LABEL, env.SEED_NAME, ...argv].filter(Boolean).join("\n");
  return /ZZ-TEST/.test(blob);
}

function assertProdHostGuard(argv = process.argv, env = process.env) {
  if (!productionTarget(env)) return;
  if (zzTestRequested(env, argv)) {
    throw new Error("refusing ZZ-TEST seeding against production");
  }
  if (!readonlySmoke(argv)) {
    throw new Error("refusing to run against production without an exact @readonly grep and an exact @write grep-invert");
  }
}

function assertProdSeed(env = process.env, label = "") {
  if (!productionTarget(env)) return;
  if (/ZZ-TEST/.test(label) || zzTestRequested(env, [])) {
    throw new Error("refusing ZZ-TEST seeding against production");
  }
  throw new Error("refusing to seed against production");
}

module.exports = {
  productionTarget,
  readonlySmoke,
  zzTestRequested,
  assertProdHostGuard,
  assertProdSeed,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--seed")) assertProdSeed(process.env, process.argv.join(" "));
    else assertProdHostGuard(process.argv, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "refusing to run against production");
    process.exit(1);
  }
}
