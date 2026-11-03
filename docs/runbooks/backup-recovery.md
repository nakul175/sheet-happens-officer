# Backup recovery acceptance

The legacy Restore check is now a **presence probe**, not recovery certification. It exits1 for missing tables/no users and2(INCONCLUSIVE) otherwise. Matching counts cannot establish content integrity; older backups can legitimately have fewer rows. A green restore claim requires the independent drill below. Production restore, DDL and any cloud-resource creation remain outside this remediation approval.

1. Product approves RPO(maximum data loss) and RTO(maximum restoration time). Until decided, record them as undecided; do not invent a passing target.
2. Database custodian supplies an existing backup ID/time, managed backup retention configuration and trusted snapshot reference(e.g. export fingerprints captured with the backup), without posting secrets. A manifest generated only from the suspect restored copy is not independent evidence.
3. Restore that backup into an explicitly isolated, authorized environment. Confirm distinct cluster/database and private target before any connection; preserve production unchanged. Record start/end and costs/cleanup owner.
4. Verify schema migration checksums, custom indexes/triggers and constraints; compare row identities/content fingerprints to the same snapshot reference. Never compare an old snapshot to a moving live database as an exact equality oracle. Validate cross-record/task-section, membership/leader and soft-delete/Undo invariants.
5. Start the corresponding app revision with synthetic/isolated external dependencies; exercise sign-in, project/task/deal read/write/Undo and suite fail-closed boundaries. No mail/consent/schedules against real recipients.
6. Capture redacted per-check outcomes, observed snapshot loss and elapsed restore time; explicitly pass/fail approved RPO/RTO. Stop owned resources and preserve evidence. Receiving engineer repeats using this runbook.

Current status: checker false-assurance fixed in candidate code; real restore acceptance remains BLOCKED on backup/reference access and agreed targets. Nothing in this document authorizes production changes.
