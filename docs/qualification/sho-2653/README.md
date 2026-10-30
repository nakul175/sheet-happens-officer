# SHO-2653 — Shell lint cleanup

Base: live ee124da2c25ae4570e1c711b8fd7cdd61af2011d.
Branch: codex/sho-2653-eng1-base-ee12. BTF issue383.

The historical unused `ago` import was already removed; `useRouter` is now used
by overlay navigation. Current Shell still had four newer warnings. This patch
uses Next Image for both existing SVG logo placements, explicitly unoptimized
and eager, with identical URL, dimensions, alt text and CSS. No optimizer or
provider call is introduced. Both sign-out handlers continue a full-page reload
to the identical same-origin /signin URL, now expressed as an absolute URL.
No lint rules or assertions are weakened.

Scope lint: Shell.tsx and ProjectView.tsx zero errors/zero warnings. Build and
both typechecks pass. Thirteen focused shared/brand/suite tests pass. Existing
real-browser Shell suite passes all three navigation/logo/sign-out cases;
existing six-case branding matrix is rerun on the isolated built candidate.
Full CI and production verification remain required before final acceptance.

Related SHO-2666 is already Staging Tested; no duplicate lane is started for it.
No suite routes, Prisma schema/migrations, Search flags, authentication API,
email/provider settings, business data or Concierge runtime changes.
