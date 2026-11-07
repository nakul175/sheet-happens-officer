import { projectAccess, type Actor, type Tx } from "@/lib/access";
import { db } from "@/lib/db";
import { ApiError, notFound } from "@/lib/http";

/**
 * APL-2652 AC3. A missing task and a task this person cannot see are the same "Task not found".
 * The page and the document proxy both use this, so the two answers cannot drift.
 */
export async function assertTaskReadable(user: Actor, id: string) {
  const t = await db.task.findUnique({ where: { id }, select: { projectId: true, deletedAt: true } });
  if (!t || t.deletedAt) throw notFound("Task");
  try {
    await projectAccess(user, t.projectId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound("Task");
    throw err;
  }
}

/** Document shown for a task 404. No id, so a missing task and a hidden task are the same bytes. */
export const TASK_UNAVAILABLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Task · Sheet Happens Officer</title>
<link rel="stylesheet" href="/task-unavailable.css">
</head>
<body>
<main id="main">
<h2>This task isn't available</h2>
<p>It may have been moved to Trash, or you may not be a member of its project.</p>
<p><a href="/my-tasks">Go to My tasks</a></p>
</main>
</body>
</html>
`;

/**
 * The caller's access to the project a record lives in. A caller who cannot see that project (not a member, or a deal
 * hidden by CRM_VISIBLE) gets the same 404 as a missing id of that record, so no route reveals that it exists (APL-2875).
 */
export async function recordAccess(user: Actor, projectId: string, what: string, opts: { write?: boolean; tx?: Tx } = {}) {
  try {
    return await projectAccess(user, projectId, opts);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw notFound(what);
    throw e;
  }
}
export const taskAccess = (user: Actor, projectId: string, opts: { write?: boolean; tx?: Tx } = {}) => recordAccess(user, projectId, "Task", opts);

