# App-only release contract

Development/production changes are currently paused. This document describes the candidate remediation; it is not permission to deploy. The production GitHub environment must have required reviewers configured by its owner before enabling this path. An environment name alone does not enforce review.

Supported entry point: manually dispatch Test and deploy on main, set deploy=true and approved_sha to the full approved workflow revision. Pushes run tests only; manual dispatch defaults to tests only. No main merge or dispatch is part of the handover remediation work.

`deploy/release.sh <full-sha>` performs a read-only migration status check before build/switch. Pending/failed migrations stop it. It never applies migrations or installs/changes schedules. Schema prerequisites must be handled by a separately reviewed, named and hash-approved runner; this app release cannot grant that approval. Schedules remain paused unless explicitly requested independently.

Current hardening queue: restart recovery, exact live identity, configuration preservation, Linux service manifest and unified qualification gates remain required before this candidate is release-ready. Do not use the legacy README procedure as production authorization. Restore and database operations retain their own explicit approvals.
