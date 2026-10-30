# SHO-2548 — Everyday UX accessibility qualification

Base: live `71977a682d5cb01f465c16507006584a3311c5dd`. BTF issue 488.
Branch: `codex/sho-2548-eng1-base-7197`.

Fresh BTF readback shows all 17 child stories Done. This qualification closes a
remaining evidence gap in the epic's zero-axe requirement; application behavior
and approved branding are unchanged.

The existing WCAG A/AA and best-practice axe tag set now runs with colour contrast
enabled and no violation filters. Layout and axe share strict screen readiness:
successful response, visible loading finished, expected heading/fixture task,
exact app origin and requested or declared canonical task destination/query.
Loading failures are no longer swallowed. Both runners refuse non-local app or
non-synthetic/local database targets before fixture creation. Axe failure shots
now live under `test-results/viewport/a11y`, included by existing CI artifact
uploads; reports retain the screen, width, original cause and screenshot path.

Local evidence:
- Baseline axe/keyboard run: 58 passed with contrast enabled.
- Complete final phone suite: 263 passed in 225 seconds, no new skips.
- Fresh webpack build, both typechecks, scoped lint and six CI-contract tests pass.
- Actual layout gate fails on a deliberate 400px element (existing proof).
- Actual axe gate fails on a deliberate low-contrast element and saves its shot.
  `SHO_A11Y_NEGATIVE_CONTROL=1` is opt-in test-only injection on Sign in at 390px;
  ordinary runs leave it off. It is behind the same local fixture guard.
- Foreign app and database probes are refused; user/project/task/session/audit
  counts are unchanged across both refused runs. No real external service is used.

Full logs, deliberate-failure screenshots and child-state evidence are retained
in `work/sho-2548-evidence`. This is automated Chromium/keyboard evidence, not a
physical-phone or manual screen-reader claim. No new mirrored unit tests, assertion
waivers, workflow changes, schema/migrations, suite changes or Concierge work.
Exact-head CI and the Eng1 production receipt are reported in the PR and BTF.
