/**
 * ff_task_comments (SHO-US-19.1). Off unless FF_TASK_COMMENTS is true, 1, on, or yes.
 * FEATURE_COMMENTS is accepted as the same switch. Read at call time, so a restart applies it.
 * With the switch off, comment routes answer 404 and no screen grows a Comments panel.
 */
/** Action-log rows that belong to comments. With the switch off, Activity leaves them out and Undo answers 404 (APL-2590 D1). */
export const COMMENT_ACTION_PREFIX = "comment.";
export const isCommentAction = (action: string) => action.startsWith(COMMENT_ACTION_PREFIX);
/** Notice types that belong to comments. With the switch off, the bell neither lists nor counts them (APL-2590 D1b). */
export const COMMENT_NOTICE_TYPES = ["COMMENT_ADDED", "COMMENT_MENTION"];

export function commentsEnabled(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.FF_TASK_COMMENTS ?? env.FEATURE_COMMENTS ?? "false").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** SHO-2591 / 19.2a: off by default. The only supplied store is development/test-only. */
export function attachmentsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return ["true", "1", "on", "yes"].includes((env.FF_ATTACHMENTS ?? "false").trim().toLowerCase());
}
export const isAttachmentAction = (action: string) => action.startsWith("attachment.");
