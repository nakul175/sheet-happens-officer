# SHO-3098–3102 record forms and Team member details

New organisation and Contact reuse the existing modal with a scoped visual class; the shared Modal change is an optional class only. Focus trapping, Escape and focus restoration are unchanged. Kind/Country remain free text. Contact retains existing selections, current-user default, required name/known people and API email validation.

Add note moves its existing composer into the approved modal over Notes. CALL and IST date defaults, all kinds, optional nonarchived deal/contact context, nonblank text, error and reset behavior stay intact. Cancel and close do not write.

New deal groups the existing fields into Opportunity, Commercial details and First next step. Field validation, buyer lookup and explicit confirmation, financial bounds, pipeline/deadline conditions, payload and navigation remain unchanged. Cancel links back to Deals. No schema or transaction changes.

Person uses existing protected reads and groups existing eligible actions in More. Member privacy, safe hidden-deal links, all failure branches and SuperAdmin/self/target checks remain unchanged. Deactivation remains navigation to Team; no direct deactivation added.

Focused validation includes original deal classification/payload tests, Accounts and contact/Note flows, Team permission matrix and Person privacy/error cases. Build/TypeScript/lint/scope and full CI required. Desktop/mobile comparison and staging/production evidence remain pending and owned through the coordinated release. No actual users, credentials or production records changed for visuals.
