# Dependency and native provenance review

Audit snapshot: 3 November 2026, live source 7c4aa841. `npm audit` reported 19 affected package entries (3 high, 16 moderate), deriving from two root advisories, not 19 independently proven runtime exploits. A fresh web lookup failed during remediation; revalidate with the package registry before release.

| Root advisory | Installed chain | Exposure / disposition |
| --- | --- | --- |
| GHSA-ggr8-5vv4-36mx (recursive object stack exhaustion) | deepmerge-ts 7.1.5 through @prisma/config 6.19.3 / Prisma | Used by Prisma configuration/tooling; no application request import found in this audit. Do not accept untrusted recursive configuration objects. Fixed range reported as >=8; upstream pins 7.1.5, so overriding across a major version needs explicit compatibility tests. OPEN. |
| GHSA-g3hv-75wg-m249 (glob amplification) | minimatch 3.1.5 / 10.2.6 through ESLint plugins / TypeScript-ESLint | Tooling processes checked-in glob/config inputs; untrusted PRs can affect CI resources. Fixed range reported as >=11.0.1. Replacing v3 callable exports with v11 is not a safe blind override. OPEN pending compatible upstream update and full lint/test qualification. |

Do not use `npm audit fix --force`, suppress advisories, or present the absence of a demonstrated request path as remediation. Dependency owner: the engineer maintaining SHO; product owner approves exceptions. Record advisory ID, installed/fixed range, reachable path, disposition, retest date and exact tested lockfile with every update.

Native runtime: `src/lib/sho-accept.c` contains the rebuild command and targets Ubuntu 24.04 / GCC 13 / Linux x86-64. `src/lib/shutdown.ts` loads the tracked `.so` through Koffi; macOS test success does not qualify this code. Before approving a release, build in the documented clean Linux toolchain, compare exported symbols and binary/source provenance, and run the shutdown/drain integration tests. Do not silently substitute an unqualified binary or update it from a different architecture. Reproducible binary verification remains OPEN.

The Holy Sheet editor is a local tarball under `vendor/`, pinned by package-lock integrity. Integrity proves consistency with the lockfile, not authorship or licence. Record its source repository/revision, build command, owner, licence and update procedure before handover. Those upstream provenance details are not established by this audit; do not invent them. OPEN.
