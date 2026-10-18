import { projectAccess, type Actor } from "@/lib/access";
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
<title>Task · Sheet Happens Officer</title>
</head>
<body>
<main id="main">
<h2>This task isn't available</h2>
<p>It may have been moved to Trash, or you may not be a member of its project.</p>
<p><a href="/">Go to My tasks</a></p>
</main>
</body>
</html>
`;
