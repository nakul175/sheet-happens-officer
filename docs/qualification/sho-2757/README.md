# SHO-2757 clock acceptance

`tests/clock-2757-server.mode.test.ts` exercises the existing signed clock through real HTTP handlers and browser pages. It runs automatically in the existing mode-test glob after a production build. All app and database targets are isolated loopback test instances. Setup, normal activity, stage transitions, archive and session cleanup use the application APIs. No row timestamps are backdated and the global clock is not mocked.

The timed criteria map to:

| Original criterion | Executed acceptance |
| --- | --- |
| APL-2525 AC6 / APL-2543 AC3 | The real stalled-deals job notifies the Leader once when called twice at the same signed future time. |
| APL-2543 AC1 | List, project detail and review APIs agree on the stalled flag; actual desktop/phone board, list, detail and review display the results. |
| APL-2543 AC2 | A real task edit clears the flag at the same supplied timestamp, just beyond the original 30-day boundary. |
| APL-2543 AC5 | Archived, Paused, Won and Lost deals have no stalled flag and receive no stalled-deal notice. |
| APL-2546 AC2 | A real idea enters the review after a signed 31-day advance, and disappears when ordinary time is read again. |
| SHO-2757 AC1 | Production ignores valid clock headers even with TEST_CLOCK=1; a development app with the flag off also ignores them. |

The existing five unit tests additionally prove remote-database refusal, missing/incorrect signatures and malformed timestamp refusal. The hook code and its four route integrations are unchanged in this qualification.

The three historical story files referenced by the proposal were never in this live source tree. Their remaining timed portions are covered here rather than merging the old UI test branch, which also contains superseded Won behavior. This is not a claim to requalify every unrelated criterion in that old branch.

Next development uses the standard compiler and an owned dependency directory; Webpack development mode failed to compile the Prisma import through instrumentation in the local qualification environment. The failed setup logs are retained with the evidence and are not counted as acceptance. Production is tested using its ordinary fresh build. Test identities are synthetic; projects and organisations are archived, sessions are revoked and owned test process groups are stopped. No production clock flag or database configuration is changed.
