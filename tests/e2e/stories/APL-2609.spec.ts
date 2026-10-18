// SHO-BUG-2 CRM_VISIBLE=admins or off still shows deals through My tasks, search, the concierge and the task routes  (Linear APL-2609)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
import { test } from "../support";

test.skip("CRM_VISIBLE=off: a deal member sees no deal row in My tasks, search, task routes or the concierge", () => {
  // Reason: the lever is a server environment variable. Staging runs with one setting and the browser cannot change it.
  // Covered by tests/crm-visible.test.ts (vitest, "CRM_VISIBLE lever (SHO-BUG-2)"). Re-run this spec against a staging started with CRM_VISIBLE=off to check by hand.
});

test.skip("CRM_VISIBLE=admins: the same for an Editor, but an Admin still sees deals", () => {
  // Reason: same as above; needs a staging restart with CRM_VISIBLE=admins and an Editor and an Admin account.
});
