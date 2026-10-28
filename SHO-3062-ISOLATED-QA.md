# Isolated SHO/HS qualification

The existing main staging service uses a separate `sho_staging` database and
cannot rotate a production source session row. Its old `.com` origin also makes
HS iframe authentication cross-site. The proposed QA origin is
`https://sho-qa.aplyd.org`: a separate origin, same site as HS, retaining the existing
SameSite cookie policy and source/host boundary. No DNS, proxy or identity-client
change is implied by this source candidate alone.

`SHO_HOLY_QA=1` activates a separate `sho-holy-qa` authorization-code/PKCE client
only when APP_URL exactly matches that origin and one to four explicit synthetic
central UUIDs are configured in SHO_HOLY_QA_SUBJECTS. It requires its own
SHO_HOLY_QA_CLIENT_SECRET and cannot fall back to production credentials. The
callback resolves the live client-specific native binding without email matching,
checks native eligibility again, and creates an independent local Session and
CentralSessionLink. Subsequent access uses live provider status with that QA client;
unlisted, revoked or mismatched identities fail closed. The ordinary production
client, origin, source-session rotation and native currentUser implementation are
preserved when this opt-in mode is absent.

Operational qualification requires an additive DNS A record for the QA hostname,
a reverse-proxy block retaining staging's existing authentication, and one dedicated
OIDC client with exact QA callback/logout URLs and links only for the reviewed dummy
identities. Client secret generation and storage remain on the host, mode0600; no
secret or token belongs in source, command arguments, screenshots or test artifacts.
The provider's existing keys, cookie keys, client entries, accounts and sessions
must remain unchanged. Loading the additive registration requires a coordinated
brief accounts-service restart; preserve its config/SQLite backups and exact
rollback. This is not permission to stop shared services during unrelated QA.

Before staging deployment, back up the dedicated staging database, retain its exact
current release, check disk space and build the exact tested candidate. Do not use
the legacy release script's automatic pruning. Assert the exact health SHA, keep
outbound email isolated, exercise real normal-login create/link/standalone/unlink,
HS revocation with native membership retained, and unchanged HS grants. Restore the
previous staging build and rehearse forward recovery without discarding test data.
The reserved slot9/private66, production release and other previews are outside scope.

This branch integrates the current reviewed SHO release rather than historical
main. Its dedicated qualification base/scope and full regression workflow preserve
the existing release gates; it must not be promoted as an accepted15 runtime.
