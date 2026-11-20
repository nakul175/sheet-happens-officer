/** Open tasks, including subtasks, block a deal from being marked Lost. */
export function blockingTaskWhere(projectId: string) {
  return { projectId, deletedAt: null, completedAt: null };
}
