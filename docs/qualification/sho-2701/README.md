# SHO-2701 — Stable Activity event kinds

Base: live81f5d06ba023af111f4556781e94d642e13b7902. BTF335.

Activity rows now expose the existing stored action as `kind`. Delete Undo and
Too old to undo controls use `task.deleted`, independent of display wording.
Project membership filtering, server Undo permissions, retention and pagination
are unchanged. No schema/migration or suite route changes. Concierge stays removed.

Regression evidence: five pure cases include changed English/Hindi/empty copy,
non-delete text resembling a delete, role-not-yet-known and unavailable flags.
Four fail before the fix; all five pass after. Two real browser cases fetch actual
Activity rows and change only rendered copy, checking fresh/31-day-old deletes as
Editor and Leader; Editor Undo is still refused by the API. Existing Activity/API
regressions also run:31passed across4files on isolated3500 and disposable local
sho_test2701 clone. Final readiness refinement rerun:2selected pass,15filtered
(not new skips and not a substitute for the full31case run). Both typechecks,
fresh webpack build and scopedzero-warning lint pass. Route proof:retired0/suite4.

Local QA data and mail are synthetic only. No production database writes. Full
exact-head release/phone CI and Eng1 production verification remain pending.
