# SHO-2642: shared deal collection rendering

`DealCollection` is the common entry point for Deals list/board, organisation deal rows and My tasks' missing-next-step cards. Both table projections share one rendering loop; the board delegates its existing movement behavior. Callers retain data fetching, filters, lifecycle, archive/Trash policy and callbacks. No API, schema, migration, package or stylesheet change is introduced. Existing BD facts remain present.

The current Home dashboard shows task/project summaries, not a deal collection; it is intentionally unchanged. Likewise, an individual Deal's metadata panel is not a collection. The original conditional AC applies where collections actually exist. The former Home missing-next-step collection now lives in My tasks and uses the shared entry point.

## Sequencing

PR7 (`crm/close-gaps`) is still open and is not an ancestor; no merge is claimed or performed. Its original sequencing gate was intended for the initial CRM rollout. The live reconciled baseline now contains the required CRM screens/APIs, and crm1/crm2 pass in live-head CI. Latest NJ instructions authorise independent Blocked work via pinned Eng1 qualification with no main merge. This refactor adopts no obsolete stage/config behavior from PR7.

## Accessibility and appearance

Multi-group acceptance exposed an existing duplicate-landmark issue in the baseline. Collections and nested board regions now include their opportunity-group/lifecycle context in accessible names. Visible stage names and layout are unchanged. The old cross-screen spec now selects the intended Unclassified group/column instead of ambiguous global regions. Default standalone Board labels remain compatible.

Five actual API/browser cases pass: role/CRM all/admins/off visibility; four collection layouts at1280/390 with current BD facts and axe; board movement and next-task callback identity; and archive/Trash/restore. Eight paired baseline/candidate element screenshots are byte-identical (four layouts × two widths). Baseline axe reports retain the old duplicate landmarks; all current audited views have zero violations. Local paired comparisons are separate from CI, where the same functional cases run without a baseline build and without skipping a test.

Initial axe failures and the later menu-selector diagnostic are retained. No axe rule or assertion was disabled; stage menu item text was left unchanged and its selector corrected. Strict API cleanup and temporary-server shutdown remain required. Application/story typechecks, scoped lint and fresh webpack compilation passed. The updated APL2531 cross-screen spec and exact-head CI are the next gates; no production claim yet.

The release browser list now includes APL2531 alongside APL2691 and the existing local specs. Its synthetic Member fixture is available only behind the existing loopback/sho_test guard; explicit staging keeps existing credentials. Pam owns independent acceptance; Eng1 will leave In Review after a suite-safe live handoff, never mark Done.
