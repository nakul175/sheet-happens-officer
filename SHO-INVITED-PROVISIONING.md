# Invited central humans in SHO (staging candidate)

This adds an opt-in relying-party path for humans who accepted a Portal email invitation and set their password in Accounts. It does not reset or replace existing SHO credentials, roles, or source sessions.

`APLYD_SHO_INVITED_SESSIONS_ENABLED=1` enables reserved `portal_sho_<creation UUID>` identities. The signed `aplyd_auth_origin=central-invited` claim selects the path, but is insufficient alone: the callback resolves the exact native ID from Accounts' live session authority and checks the current native user. Accounts independently requires the applied Portal creation receipt, active person/organisation/app grant, exact resource mapping, connector contract and verified preservation gates. No LocalAccountBinding or email inference is created.

A new native user starts as organisation MEMBER / project VIEWER. The private Portal connector permits project VIEWER/EDITOR and removal only. LEADER, organisation ADMIN/SUPER_ADMIN and additional projects require separate reviewed workflows. The unusable native password marker has no password hash; passwords stay in Accounts. Native reset, profile password change, administrator resend and local-session creation refuse these identities.

A successful central callback creates a new eight-hour native session with an exact central-session link. Every protected request checks live Accounts authority and native account status; native project authorization rereads current roles. Revoke disables only the created account, removes its selected membership and revokes its sessions. Explicit VIEWER regrant never revives old session tokens.

The optional loopback acceptance realm requires NODE_ENV=test, fixed localhost origins and a uniquely named disposable database. It cannot select public origins or a production database. All flags default off. No production deployment is part of this candidate.
