# SHO-3103 approved Sign-in

The existing Sign-in page uses a navy brand panel and raised Lato form. The central button has one uniform 16px/500 Continue with Aplyd label, centered with an18px symbol and10px gap. The symbol preserves the exact circle/polygon coordinates and fills from the provided official vector; PLYD letterforms and tagline are omitted. SHO uses its actual transparent reversed SVG.

Submit/resend handlers, safe-return expression, server centralEnabled flag/bridge exclusion, ReturnToBridge, local fields/autocomplete/noValidate, notices and recovery routes remain unchanged. No API/session/CSRF/provider changes. The central divider renders only with the central path. No real sign-in or credential operations were performed for visual QA.

Eight focused tests cover preserved bridge/safe/offsite/flag-off paths, conditional button/divider, recovery/notices, busy/error state and refused verification resend. Build/TypeScript/lint and scope invariants required. Synthetic desktop and320px screenshots reviewed at /tmp/sho-forms-evidence/signin-desktop.png and signin-mobile320.png; later staging/exact-production acceptance and rollback remain required before Done. Existing API auth digest and suite/runtime invariants remain intact.
