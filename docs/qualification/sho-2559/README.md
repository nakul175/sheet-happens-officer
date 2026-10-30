# SHO-2559 — Actual phone-screen coverage and readiness

Base: live480f25bb649e9997b97c5d9b1cbf1cf6fbb79567.
Branch:codex/sho-2559-eng1-base-480f. BTF477.

The existing phone suite mislabeled Home(`/`) as My tasks and never opened the
actual My tasks panel. Keep Home, target `/my-tasks`, and require the expected
heading or loaded task title/dialog before checking layout. Project task-panel
coverage also verifies the loaded fixture title. The task deep link supports the
existing standalone/return-path mode and its documented legacy project redirect;
assert app origin, exact destination and task query after readiness. Only that
screen declares the known canonical redirect. Unrelated redirects still fail.

Initial local execution passed160cases but timed out on6legacy task redirects:
Next retains hidden inactive skeletons. Wait only for visible loading placeholders,
then require the actual task details; do not weaken responsive/visibility checks.
After correction the full default-mode matrix passes166/166. Return-path-on
selected changed states pass30/30 (136othercases filtered, not full acceptance).
The real400px negative-control probe still fails the actual Sign in@320 suite,
names the element/screen/width and saves the expected screenshot. Six CI contract
tests pass; build/both typechecks/scopedzero-warning lint pass.

All runs use an isolated disposable local test clone and local mail. Initial
failures/screenshots and passing results retained in work/sho-2559-evidence.
Existing44px targets/16px fields/viewport-fit checks and failure-artifact uploads
are intact. Six widths320/360/390/414/599/768 now cover27screen states. Full phone
CI should execute261checks; CI duration must remain under10minutes. No application,
Prisma schema/migration, suite, auth, Search or provider changes. Full exact-head
CI and Eng1 release verification remain pending. BTF is the sole tracker.
