/**
 * ff_task_comments (SHO-US-19.1). Off unless FF_TASK_COMMENTS is true, 1, on, or yes.
 * FEATURE_COMMENTS is accepted as the same switch. Read at call time, so a restart applies it.
 * With the switch off, comment routes answer 404 and no screen grows a Comments panel.
 */
export function commentsEnabled(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.FF_TASK_COMMENTS ?? env.FEATURE_COMMENTS ?? "false").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
