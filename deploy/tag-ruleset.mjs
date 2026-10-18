// Decide whether the repository rulesets stop unprivileged users creating rel-* tags.
// Reads a JSON object { rulesets: [...] } from stdin. Prints no secret material.
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(0, "utf8"));
const rulesets = Array.isArray(data) ? data : data.rulesets || [];

function coversRel(include) {
  return (include || []).some((pattern) => {
    const value = String(pattern);
    return value === "refs/tags/rel-*" || value === "refs/tags/rel-**" || value === "rel-*" || value === "rel-**";
  });
}

const match = rulesets.find((ruleset) => {
  if (!ruleset || ruleset.target !== "tag" || ruleset.enforcement !== "active") return false;
  const include = ruleset.conditions?.ref_name?.include || [];
  const exclude = ruleset.conditions?.ref_name?.exclude || [];
  if (!coversRel(include)) return false;
  if (exclude.some((pattern) => coversRel([pattern]))) return false;
  const rules = ruleset.rules || [];
  if (!rules.some((rule) => rule && rule.type === "creation")) return false;
  const bypass = ruleset.bypass_actors || [];
  return bypass.length > 0;
});

if (!match) {
  console.error("rel-* tag creation is not restricted to a bypass list");
  process.exit(1);
}
console.log(`tag ruleset ${match.name || match.id} restricts rel-* creation`);
