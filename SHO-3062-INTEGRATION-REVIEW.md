# SHO-3062: project and task Holy Sheet documents

Projects and tasks now provide Create page and Link existing page. HS owns the
picker and its location/permission checks. The first successful created-page link
remembers a project location, shared by the project's task entry points; users can
choose another location or explicitly replace the default. An unavailable location
requires another choice. Linking never grants HS access.

SHO persists page UUIDs and native project/task foreign keys, not page titles,
blocks or permissions. References are upserted, scoped to their source, and
carry across native task project moves. Removing a reference never deletes an HS
page. The embedded document uses the pinned canonical HS-owned editor package;
Open in Holy Sheet addresses that same page. HS continues to authorize all reads,
edits and attachments. Unknown/deleted/restricted pages use the HS unavailable UI.

Every native metadata route requires current SHO access and a live central session
binding. Cookie mutations require same-origin intent and the reviewed central
subject. Project/member/task row locks use the configured Prisma schema, and
permissions/archive/deletion/source movement are rechecked before commit. All
responses are private/no-store. Frame messages require exact HS origin, source
window, channel and subject. Pending native link retries retain only opaque page
and location IDs in actor/source-scoped sessionStorage; a retry never creates a
second page. Entered page fields remain in the HS picker through creation failure.

The flag is still off by default; approved origin remains HS staging. This is a
stacked candidate on the published shared-editor launcher. The original accepted15
and launcher scope gates, central auth, runtime entry and shutdown code remain
unchanged. A dedicated scope and full-regression workflow covers this new delta.
Do not deploy it as the old accepted15 release. Actual paired normal-login browser
qualification and a reviewed isolated rollout/rollback path remain required.
