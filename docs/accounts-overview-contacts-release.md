# SHO-3090–3092 Accounts, Organisation overview and Contacts

Accounts uses the approved table and toolbar treatment, preserving URL-initialized search/kind filters, actual fields, a single displayed-match count and the explicit duplicate/Add anyway flow.

Organisation overview retains authorized deal rows and full hierarchy. Overview previews are bounded to three rows but label complete authorized source counts. Section links use the tab query parameter, preserve other parameters and support browser back/deep links. Existing Notes, Linked tasks and Tree bodies remain available. More groups the original permission-gated Archive/Unarchive and History actions. New deal and edit eligibility remain unchanged.

Contacts uses a raised table with original names, roles, contact details, all known people including inactive markers, last-spoke dates and existing permission-gated controls. Existing dialogs, API validation, removal confirmation and shared Undo behavior remain intact. No schema, API or authorization changes and no real records created for visual QA.

Focused tests cover filter hydration, source counts, bounded previews, section links, role/archive controls, duplicate confirmation, contact required fields/cancel and confirmed removal/Undo. TypeScript, build and inherited CI are required. Visual desktop/mobile staging checks, reviewed deployment and exact-revision production smoke/rollback remain pending; no BTF Done before this evidence.
