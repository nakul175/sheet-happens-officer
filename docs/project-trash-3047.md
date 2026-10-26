# Recoverable project deletion

Owner selected a separate recoverable Delete workflow for SHO-3047.

Project Leaders and organisation Admins may move a plain project to Trash after entering its exact name. Archive remains a separate read-only workflow. Deleted projects are retained indefinitely; there is no automatic purge or permanent-delete endpoint.

Deletion preserves tasks, subtasks, notes, references, members and ownership. It also sets the archive marker so existing active-view queries exclude the work. Ordinary project/task access returns not-found while deleted. Search excludes Trash even when archived results are requested. Only Leaders/Admins see project Trash and can restore. Restore returns the prior archive state, including its original timestamp; members retain their roles and assignments. Members receive deletion/restoration notices and both actions write project and organisation audit events.

Concurrent deletion/restoration refuses a stale request. Existing links retain their IDs and become available again after restoration. Deals are excluded from this project-only workflow.
