# SHO-2666 — Scoped unused-code cleanup

Base: live `0b55e786bc2dfe3407493bd3251d5e35f9f27bfd`. BTF issue 370.
Branch: `codex/sho-2666-eng1-base-0b55`.

Remove only unused code in MyTasks, Bell, activity-text, deals and records:
unused dueLabel import, unused FIELD map, unnecessary lint-disable comment, and
runtime arrays used only to define type unions. The explicit role/note unions
retain exactly the same members. No executed branch or product rule changes.

Touched files plus Shell and ProjectView lint with zero errors and warnings.
SHO-2653 already removed Shell/ProjectView warnings in the current live ancestry.
Full-repository lint has zero errors and 11 unrelated warnings, down from 16.
Profile navigation, held Holy Sheet hooks and unrelated test warnings stay outside
this unused-only change. No lint rules, assertions or skips are weakened.

Local acceptance on a fresh isolated webpack build: 46 existing feed, Activity,
CRM role/note and bell regressions pass. Home/My Tasks/task-panel viewport checks
pass 18 selected cases across six widths; 148 cases were filtered, not new skips
or a full viewport claim. Both typechecks and scoped lint pass. Logs retained in
`work/sho-2666-evidence`. No new tests mirror this unused-only diff.

Prisma schema/migrations, suite routes, Search and Concierge removal are unchanged.
Exact-head release and full phone CI, then the serial Eng1 cut, remain pending.
