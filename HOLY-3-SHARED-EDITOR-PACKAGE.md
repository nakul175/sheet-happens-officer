# Shared editor consumer candidate

SHO imports `HolySheetEditor` from `@aplyd/holy-sheet-editor/hosted` instead of
maintaining its own iframe/session lifecycle. The local and hosted entries are
distributed in the same HS-owned versioned package; HS itself uses the compiled
local entry containing its real editor/API/recovery implementation. The hosted
transport keeps credentials and recovery at the HS origin. No duplicated document
or client-supplied role is accepted.

Version `0.1.0-holy3.2` is pinned to the tarball under vendor/ and its lockfile
integrity. The provenance receipt identifies canonical HS source commit
a7a1e7fb46dec3a40251c16965ec5efbdedca3ef and its source manifest. The verification
script checks archive integrity, installed manifest and all 51 source hashes
against that exact public Git commit. CI checks source without executing it.
No npm registry publication or new shared-service credentials are involved.

The task-specific provider still calls the trusted SHO endpoint, which verifies
task access and central-session binding. Its subject restricts the HS account;
HS independently verifies its own identity, audience, live suite session and page
permissions before mounting content. Account changes lock the old frame until
explicit retry. Stale responses, invalid origins/subjects and timeouts do not
reopen it. The package owns the standalone link and reload control.

Nineteen packed consumer tests, direct TypeScript and production build pass.
Full isolated release CI remains required on this combined candidate. Live paired
SHO/HS, mobile/accessibility, media/conflict/outage and performance acceptance
are not established by this package. Flags remain off; no deployment is included.
