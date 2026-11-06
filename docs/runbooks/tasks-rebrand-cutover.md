# Tasks by aplyd cutover

Status: prepared, **not deployed**. The application branch is based on the observed live source `7c4aa8419c7f19e781e54d0681c05d4c22d68b7b`. Keep the handover audit draft PR separate.

## Names and compatibility

- Display name: **Tasks by aplyd**. The app, PWA, page titles, mail display copy and navigation use Lato. The short PWA and narrow-navigation label is **Tasks**.
- Canonical production origin: `https://tasks.aplyd.org`; canonical staging origin: `https://staging.tasks.aplyd.org`.
- Existing BTF `SHO` issue keys and Bug Sheet issue references remain stable. Rename their **project display names** to `Tasks by aplyd` after live verification. Do not rekey historical issues.
- Rename GitHub repository `nakul175/sheet-happens-officer` to `nakul175/tasks` after the new origins pass. Update local remotes, release references, repository variables and any external webhooks; verify GitHub's old URL redirect. The checked-in package name becomes `tasks-by-aplyd`.
- Keep `sho` systemd unit, `/opt/sho` paths, database names, environment keys, suite client IDs and event names during this cut. They are compatibility identifiers, not product copy. Renaming any of them requires a separate migration with dependent-service proof.
- Keep the currently verified sender mailbox domain until `tasks.aplyd.org` is verified with the mail provider. The visible sender name and email copy become `Tasks by aplyd`; swapping the sender address is a separate delivery check.

## Preflight and staged cutover

1. Record the current production/staging release and routing configuration, DNS records, certificate subjects, `APP_URL`, suite callbacks and mail sender without printing credentials. At inventory time, old production health was 200 on `7c4aa841`; old staging required authentication. The two new DNS names had no A records. The host SSH key available here was invalid, and browser use was disabled, so live Caddy configuration has not been inspected.
2. At the authoritative `aplyd.org` DNS provider, add `A` records for `tasks` and `staging.tasks` to the app host after confirming the current target IP. Verify authoritative and public resolver results. Do not change the old records yet.
3. Add the two new host blocks to live Caddy, preserving the staging basic-auth and upstream of the existing staging block. Validate Caddy configuration before reload. Verify HTTPS certificates, health, staging authentication, and the production suite route matrix on the new names. No redirect is enabled before those checks pass.
4. Deploy the app candidate to isolated staging, then authenticated shared staging. Set only the staging `APP_URL` to `https://staging.tasks.aplyd.org` in the reviewed staging configuration. Verify sign-in, mail links, Lato computed styles, nav/PWA/page titles, old-to-new link behavior, QA route containment, and all four `/api/suite/*` routes. Run required CI and relevant desktop/phone-size regression gates on the exact candidate.
5. Promote the same qualified source to production with `APP_URL=https://tasks.aplyd.org`, preserving database, service, suite client IDs and secrets. Verify live source SHA, assets, protected sign-in, mail links, suite `authorize|token|userinfo|status`, Holy Sheet link host, and absence of QA routes. Recheck the old production origin before redirecting it.
6. Only after both new hosts are healthy, configure permanent old-host redirects that preserve path and query: `sheethappensofficer.aplyd.org` → `tasks.aplyd.org`, and `staging.sheethappensofficer.com` → `staging.tasks.aplyd.org`. Verify both `/` and a benign path/query over HTTPS and HTTP, with no redirect loop. Existing host-bound session cookies do not migrate; users may need to sign in again.
7. Rename the BTF project display name and description, Bug Sheet project display name, and GitHub repository. Read each back. Keep their IDs/issue keys. Update the release runbook and repository remotes; verify CI secrets/variables and webhook delivery after the GitHub rename.

## Rollback

The app release can return to the prior release without changing the database. If a new host fails, restore the previous app `APP_URL` and Caddy upstream, and remove only the new redirects while keeping the old domains served. Do not delete old DNS records until certificate, callback, mail-link and monitoring evidence is accepted. Revert external display names if the product cut is rolled back; keep issue keys and data untouched.

## Unresolved cutover inputs

The live staging Caddy upstream and basic-auth block must be inspected before any config file is changed. This environment currently cannot reach the host by SSH and computer/browser use is disabled. The `aplyd.org` names are managed at the domain's authoritative DNS provider and do not yet resolve. No production or staging config/DNS change has been made by this branch.
