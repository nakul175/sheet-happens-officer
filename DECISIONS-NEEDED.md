# Decisions needed

A pending decision is a question the code cannot answer for itself and no tracker ticket answers either. Each entry says
what is unknown, what the repo and the tracker do say, the effect on the code for each answer, and where the question is
pinned in a test. Nothing here changes behaviour; the tests that reference an entry stay `todo` until the decision lands.

Opened by w281 (24 Oct 2026) from the orphaned-expected-fail pass over `tests/sec-2917-gaps-w41.test.ts`,
`tests/sec-2917-w256-attack.test.ts` and `tests/base-url-env-2917.test.ts`. The tracker was read only.

---

## W281-D1 — Is `sheethappensofficer.aplyd.com` a production host?

**Question.** `tests/e2e/base-url.ts` refuses to run story tests against a fixed production set
(`PRODUCTION_HOSTS`, `tests/e2e/base-url.ts:10-16`, used by `refuseProduction` at `:78-83` and again on the import-time
path at `:112-116`). The set holds `sheethappensofficer.com`, `www.sheethappensofficer.com`,
`app.sheethappensofficer.com`, `sheethappensofficer.aplyd.org` and `168.144.144.69`. It does **not** hold
`sheethappensofficer.aplyd.com`, so a run pointed at that host is allowed. Is that host production?

**Answer today: UNKNOWN.** Nothing in this repo decides it:

- the name appears nowhere in `src/`, `tests/`, `e2e/`, `.github/` or the deployment files outside the two `it.todo`
  titles that ask this question — a search for `aplyd.com` finds only mail addresses (`root.test@aplyd.com` and the
  `nakul17+…@aplyd.com` test aliases);
- the domain references that do exist are `sheethappensofficer.com` (46 occurrences: the old domain, still in the
  production set and still the email sender) and `sheethappensofficer.aplyd.org` (11: the new domain);
- SHO-2929 ("Replace hardcoded old domain after move to sheethappensofficer.aplyd.org") is the closest ticket and does
  **not** answer it: it is **Done**, its AC1/AC2 name only `sheethappensofficer.com` and `sheethappensofficer.aplyd.org`,
  and its ruling comment of 15:52 IST on 20 Oct keeps the staging hosts (`staging.sheethappensofficer.com` and the
  `prN.staging` hosts) out of scope. `.aplyd.com` is never mentioned;
- SHO-3031 and SHO-3032 are about the AC3 `/proc` guard, not about the host list; SHO-2917 AC3 is about reading the
  process image.

**Effect on the guard.**

| if the answer is | change |
|---|---|
| production | add `sheethappensofficer.aplyd.com` to `PRODUCTION_HOSTS` (`tests/e2e/base-url.ts:10-16`), then turn the two `it.todo` at `tests/base-url-env-2917.test.ts:110` and `:150` into `.toThrow(/Refusing to run story tests against production/)` cases |
| not production (a preview or a dev name) | leave the set alone, delete the two `it.todo`, and record the host here as deliberately allowed so the next reader does not reopen the question |

**Who can answer it.** Whoever owns DNS/deploy for the move (the SHO-2929 thread: Nakul Jain, Oscar). The answer is a
product/deployment fact, not a code fact, which is why it is a decision and not a bug to fix here.

**Pinned at.** `tests/base-url-env-2917.test.ts:110` (run-time guard) and `:150` (import-time guard), both `it.todo`, so
the suite neither asserts that the host is production nor that it is not.
