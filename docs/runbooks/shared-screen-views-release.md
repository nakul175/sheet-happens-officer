# SHO-2594 — Shared saved screen views

Deals, Accounts and Pipeline review can save named filters, private, workspace-shared or project-shared. Shared navigation shows the owner. Filters and URL state are applied to each viewer's existing data APIs; saving a view never stores results or grants record access. CRM hiding applies to the saved-view API and controls. Owner/Admin editing preserves ownership, and deleting a shared view requires an explicit warning/confirmation.

A separate expand-only ScreenSavedView table preserves existing personal project views. Private views are capped at 10 per owner per screen; all shared views count towards 20 per workspace. Workspace transaction advisory locking serializes create/reshare checks. Current project membership determines visibility and project-sharing eligibility on every request, including for Admins. Concierge lookup is read-only and links only to views returned by the server that turn; names remain flattened, untrusted data.

Local checks: 11 focused filter, visibility, authorization, limit and safe-link tests; TypeScript and production build; scoped ESLint. Real API integration coverage exercises membership removal, owner/Admin edits, shared-delete confirmation and concurrent private limits against CI's isolated database. Required full CI, authenticated browser journeys (all three screens), CRM modes, and exact-revision release verification are still gates. No release or Done is implied.

Deployment SHO owns migrations, staging, release and rollback. Apply expand-only migration, preserve the prior candidate, verify shared tabs with different members and record all evidence in BTF before Done. Rollback application keeps the added table; do not drop user views to roll back code.

NJ approved AC1–AC6 through Product SHO on 29 October 2026: this is additive to personal project views, which remain private and unchanged. Fresh validation must cover the current candidate; historical checks are not acceptance. No merge or deployment is authorized in this engineering assignment.
