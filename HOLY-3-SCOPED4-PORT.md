# Local compatibility port — not a rollout candidate

Based on reported live SHO source 1135b8ef8d4924b73bfb387d4e7d2305025934c4.
Ports the shared package/launcher from tested draft c2700202 without replacing
newer authentication, central-session helpers, Prisma schema, workspace-person
controls or subtask Trash UI. TaskModal receives only the launcher import/mount.
The existing period assertions retain zero-month checks and strengthen the
independent weekly count, as in the separately validated correction.

Local evidence: 22 focused launcher/period tests, strict scoped-source check and
production build (including TypeScript) pass. Package v0.1.0-holy3.2 still pins
canonical HS a7a1e7f. These checks do not validate the newer remote scoped4 tip,
the deployed binary/image, real database migrations or live paired acceptance.

Held locally while the stable qualification source/host is established. Existing
draft PR201 remains based on accepted15. Do not deploy either branch over live
SHO or bypass its release gates. The final qualification host should be HTTPS
under aplyd.org for same-site HS cookies; an unrelated .com host would require a
different security design. No DNS, Accounts client, grants or infrastructure
changes are included.
