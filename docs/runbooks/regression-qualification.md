# Regression qualification and remaining coverage

PR CI and manually requested production CI call the same `qualification.yml` workflow. Both use Node 22, a disposable PostgreSQL 16 service, the production `server.js` entry point, script tests, lint, application and story typechecks, build, suite-route preservation, mode tests, default Vitest tests and five local browser stories. Phone checks run separately for PRs and are a required dependency of the production job. No repository production database credentials are passed to qualification.

Passing these jobs is necessary, not exhaustive product acceptance. The handover audit contains a 97-case proposed regression catalog (`work/quality-review-20261103/regression-cases.csv` in the engineering workspace). It is not a record of 97 passing tests. Map each case to executable tests or a repeatable manual procedure, retain result artifacts, and mark unexecuted cases explicitly. Do not claim full coverage from collection counts or from source-string policy tests.

Minimum release evidence must include the exact commit, test command and environment, pass/fail/skip counts, artifacts for failures, browser acceptance of changed journeys, role/denied-access checks, and suite smoke. Any staged external integration requires dedicated test credentials and approved consent; it must not silently run against production.

The remaining audit gate is execution and reconciliation of that catalog against a private, representative fixture. Backup restoration and independent human onboarding are separate gates. Production remains paused until the owner approves a reviewed candidate.
