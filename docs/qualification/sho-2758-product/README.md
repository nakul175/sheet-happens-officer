# SHO-2758 product prerequisite

This separate product change gives the existing Organisation contacts table an accessible name and each contact row its contact-name label. It changes no visible text, styles, permissions, data or schema. Native table/cell semantics remain.

The migrated APL-2533 story is already present in the live Eng1 tree from PR #364, with all five contact business cases retained. Its live SHA256 is ef76ba15a82a54f94f779ea88f8625a63aa1086d48d345a867f4c5881a382922. This PR does not re-open the frozen PR #65 or merge its old branch. The missing-spec migration was a test-source port, not a database migration.

This product PR explicitly addresses the latest NJ/Pam product-PR prerequisite. Contact table/row role queries, unchanged pixel output and the existing APL-2501/APL-2533 desktop/phone business acceptance must pass on the candidate, followed by exact-head release and phone CI. No further promotion occurs before those gates are green. No Prisma migration or schema drop is included.
