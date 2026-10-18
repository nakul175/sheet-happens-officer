// Pick the oldest release artifact built by ship.yml or deploy.yml for this commit.
// Other workflows cannot pre-seed the canonical tarball by uploading the same name.
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
const data = JSON.parse(raw);
const sha = data.sha || process.env.GITHUB_SHA || "";
const allowed = new Set([".github/workflows/ship.yml", ".github/workflows/deploy.yml"]);
const name = `release-${sha}`;
const matches = (data.artifacts || [])
  .filter((artifact) => artifact && artifact.name === name && artifact.expired !== true)
  .filter((artifact) => artifact.workflow_run && artifact.workflow_run.head_sha === sha)
  .filter((artifact) => allowed.has(artifact.workflow_run.path))
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

if (matches.length === 0) process.exit(2);
process.stdout.write(String(matches[0].id));
