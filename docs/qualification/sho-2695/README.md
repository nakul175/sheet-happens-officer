# SHO-2695 — Stable forced-password error code on Person

Base: live b5d6cafa826b1360cdf61bedf19f3b9ae02bbcda.
Branch: codex/sho-2695-eng1-base-b5d6. BTF341.

The API already returns the flat `code: PASSWORD_CHANGE_REQUIRED` contract and
useGet already exposes it. Person still compared the English message. Its
settled403 branch now uses the code; no API/shared-client contract is changed.
An unrelated403 remains no-access even if its message happens to equal the old
English sentence. Private person payloads stay hidden for either denied state.

Four new regression cases reproduce the original bug: changed English/Hindi
messages with the correct code; identical old wording with a wrong/missing code.
All four fail before the predicate change and pass afterwards. Full focused run:
29pass/0fail/0skip across Person access/hidden deals, Shell and suite tests.
Existing real forced-password API regressions:13pass; existing browser login
regressions:2pass after supplying the installed Chromium path on macOS. The
initial browser setup failure is retained, not counted as a product failure/pass.
Two supplementary compiled-browser cases use a real signed-in synthetic QA
session and injected403 responses; both pass, with screenshots and no person
payload leak. Build, both typechecks and scoped zero-warning lint pass.

All runs target an existing isolated disposable local QA clone; mail stays local.
No migrations/schema drops, suite routes, auth API, provider settings, Search
flags or Concierge changes. Full exact-head CI and suite-safe production cut
remain required. Evidence is retained in work/sho-2695-evidence.
