// CI tier — WHAT "NO TEST CAN REACH THIS" MEANS, AS A FILE THE SUITE READS.
//
// W133 traced the frozen 35-ticket set to its tests and found clauses no in-repo test can discharge. That finding lived
// only inside a report (W133-REPORT.md §4), so a reader could not tell a deliberate exclusion from an oversight, and the
// ledger had to be believed rather than checked. This module is that exclusion list as data: one entry per AC clause of
// the frozen set, with the status and - for anything that is not TESTED - the reason from a closed vocabulary.
//
// The three statuses mean exactly this, and nothing more:
//
//   TESTED                A test file exists, names this ticket (or the carrier ticket its titles use), and I read the
//                         token in `asserts` in it. `verified` says how deep that reading went: "body" = I read the
//                         assertion in the test body; "title" = I read the test's title and confirmed the file contains
//                         the token, but did not read the whole body. A TESTED entry is therefore NOT a claim that the
//                         test is a good test, only that it exists and names/asserts this clause. See LIMIT below.
//   NOT-TESTABLE-IN-REPO  The clause's observable cannot be produced inside a test process at all. `reason` is one of
//                         REASONS, and that is the point of the entry: host (a real hostname, socket or TLS handshake),
//                         deploy (a post-deploy state), process (a CI conclusion for a given SHA), human (a named
//                         person's sign-off, or a decision not yet made), pointer (the requirement's subject lives
//                         outside the repo, so there is nothing to assert).
//   UNTESTED              Reachable in principle, and no in-repo test asserts it today. Not a failure on its own - a
//                         count is printed on every run - but the committed baseline records which entries were TESTED,
//                         and losing one back to UNTESTED fails scripts/ci/ac-coverage.test.mjs.
//
// `clause` is a short quote of the requirement, transcribed from W133's matrix, which is itself a transcription of
// AC-TRUTH-TABLE-35.md. It is not the tracker. Where a clause bundles a checkable half with an unreachable one, the
// status follows the half the vocabulary can name (a clause whose only gap is "CI is green" is NOT-TESTABLE/process,
// not UNTESTED) and `note` records what the status does not cover.
//
// Nothing here runs the product. This file is data; the test beside it checks the data against the filesystem.

/** The closed vocabulary for NOT-TESTABLE-IN-REPO. A new reason means changing this list, which is a deliberate act. */
export const REASONS = Object.freeze(["host", "process", "human", "pointer", "deploy"]);

/** The only statuses an entry may carry. */
export const STATUSES = Object.freeze(["TESTED", "NOT-TESTABLE-IN-REPO", "UNTESTED"]);

/**
 * The frozen set: 35 tickets, exactly the rows W133's matrix covers. The aggregate test pins this list, so a 36th row
 * or a dropped row is a red test - "all 35 are covered" is the one claim the manifest exists to make checkable.
 */
export const TICKETS = Object.freeze([
  "2671", "2689", "2693", "2725", "2736", "2738", "2760", "2840", "2897", "2917",
  "2918", "2919", "2920", "2921", "2922", "2923", "2924", "2951", "2996", "2997",
  "2998", "3000", "3010", "3011", "3012", "3013", "3017", "3019", "3024", "3025",
  "3029", "3030", "3031", "3032", "3033",
]);

/**
 * What this manifest cannot prove, quoted by the test so the limit travels with the counts.
 * A TESTED entry says a test exists and names the clause. It does not say the test is any good.
 */
export const LIMIT =
  "A TESTED entry proves only that a test file exists and names or asserts this clause. It does not prove the test is "
  + "a GOOD test: that it is not vacuous, that it would fail if the behaviour regressed, that the dev server was up, or "
  + "that the assertion covers the clause rather than a neighbour of it. Counts here are about reachability, not quality.";

/**
 * One entry per AC clause. `id` is `${ticket} ${clauseKey}` and is what the baseline records.
 * Fields: id, ticket, clause, status, test ("path:line", TESTED only), asserts (token present in `test`'s file,
 * TESTED only), carrier (the ticket id the file's titles actually use, when it differs from `ticket`), reason
 * (NOT-TESTABLE only), verified ("body" | "title", TESTED only), note (free text; required when not TESTED).
 */
export const ENTRIES = Object.freeze([
  // ---- 2671: subtask reopen cascade -------------------------------------------------------------------------------
  { id: "2671 AC1", ticket: "2671", clause: "cascade-completed subtasks reopen", status: "TESTED",
    test: "tests/should-2671-reopen-subtasks.test.ts:58", verified: "title",
    asserts: "SHO-2671 AC1: subtasks completed with the parent reopen with it" },
  { id: "2671 AC2", ticket: "2671", clause: "an independently ticked subtask stays done", status: "TESTED",
    test: "tests/should-2671-reopen-subtasks.test.ts:100", verified: "title",
    asserts: "SHO-2671 AC2: a subtask ticked done on its own stays done" },
  { id: "2671 AC3", ticket: "2671", clause: "the mix reopens only the cascade half", status: "TESTED",
    test: "tests/should-2671-reopen-subtasks.test.ts:157", verified: "title",
    asserts: "SHO-2671 AC3: a mix reopens only the cascade subtasks" },

  // ---- 2689: SIGTERM drain ----------------------------------------------------------------------------------------
  { id: "2689 AC1", ticket: "2689", clause: "all in-flight requests return 200", status: "TESTED",
    test: "tests/shutdown-next.test.ts:444", verified: "title",
    asserts: "40 signed-in GET / mid-flight all return 200, exit 0" },
  { id: "2689 AC2", ticket: "2689", clause: "refused no later than one SYN retransmission, within 1.2 s",
    status: "TESTED", test: "tests/shutdown-next.test.ts:260", verified: "title",
    asserts: "refuses the +16ms and +143ms connections at once",
    note: "pins the refusal at 16ms and 143ms; the 1.2 s bound is the harness's own timing, not asserted as a deadline" },
  { id: "2689 AC3", ticket: "2689", clause: "drain log only after completion", status: "TESTED",
    test: "tests/shutdown-next.test.ts:436", verified: "body",
    asserts: "drained line only after the last response completed",
    note: "the assertion lives in the shared helper every signed-in-burst test calls, so it holds for both entry "
      + "points and both concurrency rows; :293 is the timeout path and is not what discharges this" },
  { id: "2689 AC4", ticket: "2689", clause: "the process exits 0", status: "TESTED",
    test: "tests/shutdown-next.test.ts:444", verified: "title", asserts: "exit 0" },
  { id: "2689 AC5", ticket: "2689", clause: "re-run on the staging preview with the run output attached",
    status: "NOT-TESTABLE-IN-REPO", reason: "deploy",
    note: "an evidence artefact from a staging run; tests/shutdown-next.test.ts runs on this laptop" },

  // ---- 2693: assign without a person ------------------------------------------------------------------------------
  { id: "2693 AC1", ticket: "2693", clause: "the last assistant turn asks to whom", status: "TESTED",
    test: "tests/sho-2693.test.ts:65", verified: "title",
    asserts: "AC1: the model's own words are replaced by the server's question" },
  { id: "2693 AC2", ticket: "2693", clause: "no confirm card and the assignee is unchanged", status: "TESTED",
    test: "tests/sho-2693.test.ts:88", verified: "title",
    asserts: "AC2: no card and no proposal is stored, and the assignee is unchanged" },
  { id: "2693 AC3", ticket: "2693", clause: "a confirm card appears as today once a person is named",
    status: "TESTED", test: "tests/sho-2693.test.ts:102", verified: "title",
    asserts: "AC3: naming the person still produces the confirm card" },

  // ---- 2725: apex HEAD --------------------------------------------------------------------------------------------
  { id: "2725 AC1", ticket: "2725", clause: "301 to the app, and https completes with a valid certificate",
    status: "NOT-TESTABLE-IN-REPO", reason: "host",
    note: "the redirect half is asserted in-process at tests/apex-head-2725.test.ts:26; the certificate clause needs a "
      + "TLS handshake to the real name, which a proxy() unit test never opens" },

  // ---- 2736: stage removal ----------------------------------------------------------------------------------------
  { id: "2736 AC1", ticket: "2736", clause: "without a target 409 and nothing removed; with one, items move",
    status: "TESTED", test: "tests/apl-2736.test.ts:114", verified: "title",
    asserts: "AC1: a stage with items is not removed without a choice" },

  // ---- 2738: keyboard sheet ---------------------------------------------------------------------------------------
  { id: "2738 AC1", ticket: "2738", clause: "the sheet follows visualViewport", status: "TESTED",
    test: "tests/keyboard-sheet-2738.test.tsx:84", verified: "title",
    asserts: "republishes the height when the keyboard opens, and clears it all on close",
    note: "jsdom: pins the visualViewport signal the clause names, not the geometry - no layout, no keyboard" },

  // ---- 2760: no AC ------------------------------------------------------------------------------------------------
  { id: "2760 NONE", ticket: "2760", clause: "no AC: three mutually exclusive options, unruled",
    status: "NOT-TESTABLE-IN-REPO", reason: "human",
    note: "any test written today pins an outcome the ticket has not chosen; git grep '2760' -- tests e2e finds "
      + "nothing but a comment in scripts/drain-burst.mjs:22" },

  // ---- 2840: comment-cap undo -------------------------------------------------------------------------------------
  { id: "2840 AC1", ticket: "2840", clause: "Undo at 200 live comments is refused with too_many_comments",
    status: "TESTED", test: "tests/sho-2840-cap-wire.test.ts:11", verified: "title",
    asserts: "at 200 returns 409 too_many_comments" },

  // ---- 2897: APL-2609 outbox gate ---------------------------------------------------------------------------------
  { id: "2897 AC1", ticket: "2897", clause: "the APL-2609 spec sets its own EMAIL_OUTBOX_DIR temp dir",
    status: "UNTESTED",
    note: "tests/apl-2609-outbox-gate.test.ts makes a mkdtemp for the child at :47 and never asserts the spec's own "
      + "setup, which is what AC1 is about" },
  { id: "2897 AC2", ticket: "2897", clause: "no skip gate except SHO_QA_PASS", status: "UNTESTED",
    note: "the receipt asserts a skip gate keyed on EMAIL_OUTBOX_DIR (:67, :70) - the opposite of the clause as "
      + "transcribed - so it is not laundered into TESTED; one of the two texts is wrong and the repo cannot say which" },
  { id: "2897 AC3", ticket: "2897", clause: "test-only, CI green", status: "NOT-TESTABLE-IN-REPO", reason: "process",
    note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 2917: no whole-environment read -----------------------------------------------------------------------------
  { id: "2917 AC1", ticket: "2917", clause: "no test reads /proc/self/environ; named vars only", status: "TESTED",
    test: "tests/base-url-no-environ-dump.test.ts:810", verified: "title",
    asserts: "SHO-2917 AC1: no file under tests/ reads the environment as a whole" },
  { id: "2917 AC2", ticket: "2917", clause: "same base-URL behaviour for local/staging/preview, CI green",
    status: "UNTESTED",
    note: "the guard half is asserted at tests/base-url-env-2917.test.ts:73 and :85, but two it.todo at :104 and :140 "
      + "record an OPEN defect (is sheethappensofficer.aplyd.com production?); the clause is open, not merely unnamed" },
  { id: "2917 AC3", ticket: "2917", clause: "a guard fails if any test reads /proc/self/environ", status: "TESTED",
    test: "tests/no-proc-environ-2917.test.ts:302", verified: "title",
    asserts: "no file under tests/ reads the process environment image" },

  // ---- 2918, 2919: story locators and the seeded organisation ------------------------------------------------------
  { id: "2918 AC1", ticket: "2918", clause: "the tree-parent link is found by a scoped role/name locator",
    status: "TESTED", test: "tests/sho-2918-2919-apl2536.test.ts:40", verified: "title",
    asserts: "ships the tree-scoped, exact locator and not the unscoped one" },
  { id: "2919 AC1", ticket: "2919", clause: "<term> is a substring of the seeded organisation's exact name",
    status: "TESTED", test: "tests/sho-2918-2919-apl2536.test.ts:129", verified: "title",
    asserts: "ships a query built from the organisation's own exact name" },

  // ---- 2920-2924: Playwright stories whose receipts W133 named -----------------------------------------------------
  { id: "2920 AC1", ticket: "2920", clause: "waits for /projects/<newId>, newId != sourceId, passes on staging",
    status: "UNTESTED", carrier: "APL-2538",
    note: "tests/e2e/stories/APL-2538.spec.ts:133-134 does waitForURL + not.toBe, but nothing in that file names "
      + "SHO-2920 (no title, no comment), so the receipt cannot be checked; also never run here: no SHO_ADMIN_*" },
  { id: "2921 AC1", ticket: "2921", clause: "the Buyer link is found by a role/name locator scoped to its field",
    status: "UNTESTED", carrier: "APL-2539",
    note: "tests/e2e/stories/APL-2539.spec.ts:22 scopes the locator, but the file names APL-2539 and SHO-2996 only - "
      + "no SHO-2921 marker anywhere in it" },
  { id: "2922 AC1", ticket: "2922", clause: "Remove is located within the Funder chip only; Partner remains",
    status: "UNTESTED", carrier: "APL-2540",
    note: "APL-2540.spec.ts:56-62 scopes the chip and the comment names SHO-2922, but no test title states the clause "
      + "and no test reads the spec's locator shape" },
  { id: "2923 AC1", ticket: "2923", clause: "the archived buyer link is scoped to the parties section",
    status: "UNTESTED", carrier: "APL-2540",
    note: "APL-2540.spec.ts:131 comment names SHO-2923; no title does, and no test asserts the locator shape" },
  { id: "2924 AC1", ticket: "2924", clause: "the task result is found by role and exact title, not the .item class",
    status: "TESTED", test: "tests/e2e/stories/APL-2545.spec.ts:56", verified: "body", carrier: "APL-2545",
    asserts: ".filter({ has: admin.page.getByText(t.title, { exact: true }) })",
    note: "a Playwright story: the body proves .item is ambiguous (toHaveCount(2) at :68), then resolves the task by "
      + "role, the type line and the exact title. NO EXECUTION EVIDENCE: this spec was never run in this slot and no "
      + "run of it is recorded, so TESTED here is a reading of the file, not a green result" },

  // ---- 2951: usage month figure ------------------------------------------------------------------------------------
  { id: "2951 AC1", ticket: "2951", clause: "the test removes every ledger row it creates", status: "TESTED",
    test: "tests/usage-month-figure-2951.test.ts:43", verified: "body",
    asserts: "expect(problems, problems.join" },
  { id: "2951 AC2", ticket: "2951", clause: "a missing messages figure shows a no-data state, not 0",
    status: "UNTESTED",
    note: "the only it() (:48) names row counting and that the figure survives the safety cap; nothing names a no-data "
      + "figure, and I did not find an assertion for one" },
  { id: "2951 AC3", ticket: "2951", clause: "tests cover both, CI green", status: "NOT-TESTABLE-IN-REPO",
    reason: "process", note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 2996, 2997, 2998: the locator repairs, and the staging run ---------------------------------------------------
  { id: "2996 AC1", ticket: "2996", clause: "line 18 uses a role/test-id/label locator", status: "TESTED",
    test: "scripts/ci/story-locators.test.mjs:47", verified: "body",
    asserts: "APL-2539 must name the panel through dealPanel(admin.page)",
    note: "two assertions, one clause: this one pins the spec's call site to dealPanel(admin.page) with an anchored "
      + "pattern, so a positional form on that line is red, and the parent-step scan at :31 is red for "
      + "`.locator(\"..\")` anywhere in the specs; the helper's own getByRole(\"region\", { name: \"Deal\" }) is "
      + "asserted in the sibling test at :70. The line number is not asserted - the file moved once already" },
  { id: "2996 AC2", ticket: "2996", clause: "the spec still passes in the staging regression run",
    status: "NOT-TESTABLE-IN-REPO", reason: "deploy",
    note: "a staging-run outcome; no SHO_ADMIN_* exists in this slot, and the run is not a repo fact" },
  { id: "2996 AC3", ticket: "2996", clause: "only test files change", status: "UNTESTED",
    note: "nothing asserts the change set of the commit" },
  { id: "2997 AC1", ticket: "2997", clause: "line 44 uses such a locator", status: "TESTED",
    test: "scripts/ci/story-locators.test.mjs:83", verified: "body",
    asserts: "assert.equal(uses.length, 2",
    note: "APL-2540.spec.ts has exactly two `const <x> = dealPanel(` call sites - :44 for AC1 and :113 for AC3 - so "
      + "dropping either to a `.locator(\"..\")` parent walk or a positional form takes the count to 1 and this is red "
      + "(the scan at :31 also forbids the parent-step form anywhere). The count is pinned, not the line number" },
  { id: "2997 AC2", ticket: "2997", clause: "the spec still passes in the staging regression run",
    status: "NOT-TESTABLE-IN-REPO", reason: "deploy", note: "as 2996 AC2" },
  { id: "2997 AC3", ticket: "2997", clause: "only test files change", status: "UNTESTED",
    note: "nothing asserts the change set of the commit" },
  { id: "2998 AC1", ticket: "2998", clause: "line 118 uses such a locator", status: "UNTESTED",
    note: "APL-2540.spec.ts:118 is getByRole(\"link\", { name: who }); no title names SHO-2998 and no test asserts it" },
  { id: "2998 AC2", ticket: "2998", clause: "the spec still passes in the staging regression run",
    status: "NOT-TESTABLE-IN-REPO", reason: "deploy", note: "as 2996 AC2" },
  { id: "2998 AC3", ticket: "2998", clause: "only test files change", status: "UNTESTED",
    note: "nothing asserts the change set of the commit" },

  // ---- 3000: @local-only exclusion list ----------------------------------------------------------------------------
  { id: "3000 AC1", ticket: "3000", clause: "the printed exclusion list matches every @local-only test",
    status: "TESTED", test: "tests/staging-local-only-list.test.ts:41", verified: "body",
    asserts: "tagged @local-only but not named in the summary" },
  { id: "3000 AC2", ticket: "3000", clause: "exclusion behaviour unchanged", status: "UNTESTED",
    note: "the file pins the printed list only; nothing asserts what the runner then excludes" },
  { id: "3000 AC3", ticket: "3000", clause: "CI is green", status: "NOT-TESTABLE-IN-REPO", reason: "process",
    note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 3010: concierge echo ---------------------------------------------------------------------------------------
  { id: "3010 AC1", ticket: "3010", clause: "isEcho is true for the typed text in quotes plus one full stop",
    status: "TESTED", test: "tests/concierge-echo.test.ts:66", verified: "title",
    asserts: "SHO-3010 AC1: $label is judged an echo" },
  { id: "3010 AC2", ticket: "3010", clause: "near-copies are echoes, real rewrites are not", status: "TESTED",
    test: "tests/concierge-echo.test.ts:61", verified: "title",
    asserts: "is an echo for the server rule and offers nothing on the client" },
  // W241 closed this one. W133 read only tests/concierge-echo.test.ts and was right that no it() there names the 502
  // answer; the route-level receipt had landed in tests/concierge-improve.test.ts (35cbdd7), so the clause was absent
  // from the manifest, not from the tree. The entry is now TESTED, and the receipt is a falsifier by mutation, not by
  // belief: route swallowing the ApiError -> 4 failed | 12 passed (the AC3 rows only); recordUsage counted:false and
  // ApiError 502->400 -> the same rows red. Nothing in `asserts` names the client half: offeredRewrite is
  // tests/concierge-echo.test.ts and is claimed by 3010 AC2.
  { id: "3010 AC3", ticket: "3010", clause: "502 with exactly one counted: true row, no rewrite", status: "TESTED",
    test: "tests/concierge-improve.test.ts:222", verified: "body",
    asserts: "qa:TC missing AC3: %s is answered 502 with AC3's sentence and exactly one counted:true row, no rewrite" },
  { id: "3010 AC4", ticket: "3010", clause: "a test covers it, CI green", status: "NOT-TESTABLE-IN-REPO",
    reason: "process", note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 3011: per-schema reads -------------------------------------------------------------------------------------
  { id: "3011 AC1", ticket: "3011", clause: "with ?schema=<name> every SQL read targets <name>", status: "TESTED",
    test: "tests/sho-3011-schema-strip.test.ts:63", verified: "body",
    asserts: "SET search_path TO \"${SCHEMA}\"",
    note: "W232: the case's title says AC2 while the assertion is AC1's - localSql() is handed a URL naming w193, the "
      + "statement it sends is pinned with SET search_path TO \"w193\" and the helper then asks the server for "
      + "SELECT current_schema(). Scope, stated plainly: this is the shared psql helper's statement path "
      + "(tests/e2e/helpers/local-clock.ts), not Prisma's own reads, so 'every SQL read' is enforced for that one "
      + "path and no other; the schema-mismatch case (:105) is what turns a statement that ran elsewhere into an "
      + "error rather than a green run" },
  { id: "3011 AC2", ticket: "3011", clause: "without it, unchanged", status: "UNTESTED",
    note: "still no test of the PRODUCT's no-parameter path. The two no-schema cases in "
      + "tests/sho-3011-schema-strip.test.ts (:77, :90) are titled AC2 but are about the test helper: a URL with no "
      + "?schema= is now REFUSED by name and psql is never started, which is the opposite of 'unchanged' for that "
      + "helper. A test whose title claims AC2 while asserting a refusal is not a receipt for this clause, so the "
      + "status does not move" },
  { id: "3011 AC3", ticket: "3011", clause: "the local-only guard still refuses non-local and nothing is logged",
    status: "UNTESTED", note: "no test in the named receipt asserts the guard or the absence of a log line" },
  { id: "3011 AC4", ticket: "3011", clause: "a test covers it, CI green", status: "NOT-TESTABLE-IN-REPO",
    reason: "process", note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 3012: the default-cap percentage ---------------------------------------------------------------------------
  { id: "3012 AC1", ticket: "3012", clause: "the comment above ceiling matches the code", status: "UNTESTED",
    note: "nothing asserts a comment; tests/usage-percent-default-cap.test.ts pins the behaviour the stale comment "
      + "described, not the comment's text" },
  { id: "3012 AC2", ticket: "3012", clause: "the /api/usage payload is unchanged", status: "UNTESTED",
    note: "no test names the payload shape" },
  { id: "3012 AC3", ticket: "3012", clause: "ceiling.percent is 50 for configured: false and $50 of $100",
    status: "TESTED", test: "tests/usage-percent-default-cap.test.ts:69", verified: "body",
    asserts: "expect(s.ceiling.percent).toBe(50)" },
  { id: "3012 AC4", ticket: "3012", clause: "a test covers it, CI green", status: "NOT-TESTABLE-IN-REPO",
    reason: "process", note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 3013: the default-cap card ----------------------------------------------------------------------------------
  { id: "3013 AC1", ticket: "3013", clause: "$100.004 shows the signal, $99.999 does not", status: "TESTED",
    test: "tests/usage-ceiling.test.tsx:93", verified: "body",
    asserts: "The default $100.00 safety cap has been reached." },
  { id: "3013 AC2", ticket: "3013", clause: "below $100 no signal and the existing text unchanged", status: "TESTED",
    test: "tests/usage-ceiling.test.tsx:93", verified: "body",
    asserts: "No ceiling set, default $100.00 safety cap applies",
    note: "the card is rendered to an HTML string and grepped: string presence is not visibility, and no CSS runs" },
  { id: "3013 AC3", ticket: "3013", clause: "still no percentage, no meter, no Over ceiling", status: "TESTED",
    test: "tests/usage-ceiling.test.tsx:114", verified: "body", asserts: "not.toContain(\"Over ceiling\")" },
  { id: "3013 AC4", ticket: "3013", clause: "a test covers it, CI green", status: "NOT-TESTABLE-IN-REPO",
    reason: "process", note: "the CI conclusion for a SHA is not observable from inside a test run" },

  // ---- 3017: staging alias verification ----------------------------------------------------------------------------
  { id: "3017 AC1", ticket: "3017", clause: "find the root cause and write it down on the issue",
    status: "NOT-TESTABLE-IN-REPO", reason: "pointer",
    note: "an RCA in the tracker's prose; nothing in the repo records it. tests/provision-staging-aliases.test.ts is a "
      + "mock-account harness whose titles name APL-2748/APL-3017, not SHO-3017" },
  { id: "3017 AC2", ticket: "3017", clause: "the aliases stay verified across staging deploys",
    status: "NOT-TESTABLE-IN-REPO", reason: "deploy",
    note: "a cross-deploy property; no receipt title states it" },
  { id: "3017 AC3", ticket: "3017", clause: "after the next staging deploy show all 66 verified, evidence attached",
    status: "NOT-TESTABLE-IN-REPO", reason: "deploy",
    note: "a post-deploy observation with an evidence artefact" },

  // ---- 3019: locked undo -------------------------------------------------------------------------------------------
  { id: "3019 EXPECTED", ticket: "3019",
    clause: "Undo at 200 live comments must answer 409 on the locked apply path too", status: "TESTED",
    test: "tests/sho-3019-locked-undo-409.test.ts:77", verified: "title",
    asserts: "answers 409 when the task reaches 200 live comments before the locked count",
    note: "the ticket's Expected asks for a test that FAILS while the defect is open; it passes, so TESTED here means "
      + "asserted, not 'the ticket was right'" },

  // ---- 3024: RETURN_PATH_LOG ---------------------------------------------------------------------------------------
  { id: "3024 BULLET-1", ticket: "3024", clause: "RETURN_PATH_LOG is set, or the dead reference removed",
    status: "TESTED", test: "tests/test-env-contract.test.ts:127", verified: "body",
    asserts: "RETURN_PATH_LOG=1 on the dev server line",
    note: "W232, re-derived at HEAD: the old note (\"nothing asserts the variable exists where the code expects it\") "
      + "is false and was already false at the baseline. Four assertions in this file pin exactly that: the README's "
      + "dev-server line sets RETURN_PATH_LOG=1 (:127), package.json's dev script sets it (:136), src/proxy.ts gates "
      + "the [return-path] line on it (:141) and ci.yml starts next start with it (:154). The file's titles name the "
      + "probe, not SHO-3024 - the ticket id appears only in the comment at :149 - so the attribution is the same "
      + "kind BULLET-2 discloses, not a title that names the ticket. What it does not prove: that any run of "
      + "tests/return-to.test.ts succeeded, which is a different hand and stays in that test's own record" },
  { id: "3024 BULLET-2", ticket: "3024", clause: "a test covers it", status: "TESTED",
    test: "tests/return-to.test.ts:817", verified: "body",
    asserts: "[return-path] /tasks/v16-probe?q=${encoded}",
    note: "the covering test is titled 'D9 AC2 v1.6 ...', not SHO-3024 - only the comment at :810 names the ticket - "
      + "and it requires the [return-path] line each probe wrote while that test ran, so a server started without "
      + "RETURN_PATH_LOG fails it" },
  { id: "3024 BULLET-3", ticket: "3024", clause: "Pam PASS on the fix PR", status: "NOT-TESTABLE-IN-REPO",
    reason: "human", note: "a named person's review decision on a forge, not a repo fact" },

  // ---- 3025: Escape flakiness --------------------------------------------------------------------------------------
  { id: "3025 BULLET-1", ticket: "3025",
    clause: "the Escape test passes consistently (e.g. 10 consecutive runs) on main", status: "UNTESTED",
    note: "tests/dialog-escape-3025.test.tsx proves one jsdom run (:189 and siblings); neither 10 consecutive runs nor "
      + "'on main' is asserted - 'consistently' has no threshold in the ticket to assert against" },
  { id: "3025 BULLET-2", ticket: "3025", clause: "the root cause of flakiness is fixed, not just retried",
    status: "NOT-TESTABLE-IN-REPO", reason: "human",
    note: "a verdict on a diff; 10 green runs is also what a retry-based non-fix produces" },
  { id: "3025 BULLET-3", ticket: "3025", clause: "Pam PASS on the fix", status: "NOT-TESTABLE-IN-REPO",
    reason: "human", note: "a named person's sign-off" },

  // ---- 3029: hidden-deals count ------------------------------------------------------------------------------------
  { id: "3029 AC1", ticket: "3029", clause: "the hidden-deals count issue described in the #156 notes is fixed",
    status: "NOT-TESTABLE-IN-REPO", reason: "pointer",
    note: "the requirement's subject is in Jim 46's review notes on #156 and is never stated in the ticket, so no test "
      + "can know what would make it false; tests/deactivate-fellback-2995.test.ts:87 enforces an interpretation" },
  { id: "3029 AC2", ticket: "3029", clause: "a test covers it", status: "TESTED",
    test: "tests/deactivate-fellback-2995.test.ts:87", verified: "title",
    asserts: "SHO-3029: the moved count leaves out tasks on a hidden deal",
    note: "covers the interpretation, not AC1 as written - AC1 above is the pointer" },
  { id: "3029 AC3", ticket: "3029", clause: "Pam PASS", status: "NOT-TESTABLE-IN-REPO", reason: "human",
    note: "a named person's sign-off" },

  // ---- 3030: dialog wording ----------------------------------------------------------------------------------------
  { id: "3030 AC1", ticket: "3030", clause: "the dialog text matches the wording agreed in the #156 notes",
    status: "NOT-TESTABLE-IN-REPO", reason: "pointer",
    note: "the agreed string exists nowhere in the repo or the ticket; tests/deactivate-wording-3030.test.ts pins "
      + "FALLBACK_HINT's current strings (:24-33), which is a different sentence from 'the agreed wording'" },
  { id: "3030 AC2", ticket: "3030", clause: "Pam PASS", status: "NOT-TESTABLE-IN-REPO", reason: "human",
    note: "a named person's sign-off" },

  // ---- 3031, 3032, 3033: no AC section, the Expected clause is the requirement --------------------------------------
  { id: "3031 EXPECTED", ticket: "3031", clause: "a file that never builds a /proc environ path is not flagged",
    status: "TESTED", test: "tests/no-proc-environ-2917.test.ts:366", verified: "body",
    asserts: "expect(environReaders([{ file: \"y.ts\", text }]), text).toEqual([])" },
  { id: "3032 EXPECTED", ticket: "3032", clause: "the guard flags a mid-word split such as '/pr' + 'oc/self/environ'",
    status: "TESTED", test: "tests/no-proc-environ-2917.test.ts:381", verified: "body",
    asserts: "expect(environReaders([{ file: \"x.ts\", text }]), text).toEqual([\"x.ts\"])" },
  { id: "3033 EXPECTED", ticket: "3033", clause: "the comment credits the row lock, not the FK", status: "UNTESTED",
    note: "tests/deals-stage-fk-3033.test.ts:41 greps the comment for /updateMany/ and /ON DELETE SET NULL/ and for the "
      + "absence of the old 'never sets a deal's stage to null' sentence - token presence, not attribution. A comment "
      + "reading 'the key does it; the updateMany is irrelevant' would satisfy all three, and nothing asserts that the "
      + "comment credits the row lock at all. The real comment (src/lib/deals.ts:264-268) does credit the lock and the "
      + "updateMany, so the clause is true of the code; no test asserts it as attribution" },
]);

/** Counts, computed from the entries so the report and the test can never disagree with the data. */
export function summarize(entries = ENTRIES) {
  const byStatus = { TESTED: 0, "NOT-TESTABLE-IN-REPO": 0, UNTESTED: 0 };
  const byReason = Object.fromEntries(REASONS.map((r) => [r, 0]));
  const byVerified = { body: 0, title: 0 };
  const tickets = new Set();
  for (const entry of entries) {
    byStatus[entry.status] += 1;
    tickets.add(entry.ticket);
    if (entry.reason) byReason[entry.reason] += 1;
    if (entry.status === "TESTED") byVerified[entry.verified] += 1;
  }
  return {
    clauses: entries.length,
    ticketsCovered: tickets.size,
    status: byStatus,
    reason: byReason,
    verified: byVerified,
  };
}
