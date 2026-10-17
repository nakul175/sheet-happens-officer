// Which project actions Undo can reverse, and what to call them (SHO-US-6.4).
export const UNDO_LABELS: Record<string, string> = {
  "task.created": "Task created",
  "task.updated": "Task edited",
  "task.assigned": "Task reassigned",
  "task.collaborator_added": "Collaborator added",
  "task.collaborator_removed": "Collaborator removed",
  "task.approver_changed": "Approver changed",
  "task.sent_for_approval": "Task sent for approval",
  "task.sent_back": "Task sent back",
  "task.completed": "Task completed",
  "task.reopened": "Task reopened",
  "task.moved": "Task moved",
  "task.deleted": "Task deleted",
  "task.restored": "Task restored",
  "project.updated": "Project edited",
  "project.archived": "Project archived",
  "project.unarchived": "Project unarchived",
  "project.leader_changed": "Leader changed",
  "member.added": "Member added",
  "member.removed": "Member removed",
  "member.role_changed": "Role changed",
  "section.added": "Section added",
  "section.renamed": "Section renamed",
  "section.moved": "Section moved",
  "section.done_changed": "Done section changed",
};
export const isUndoable = (action: string) => action in UNDO_LABELS;
export const UNDO_DAYS = 30;
