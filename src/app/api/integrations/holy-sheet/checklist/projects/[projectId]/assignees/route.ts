import { handle } from "@/lib/http";
import { holySheetSuiteActor } from "@/lib/suite-oauth";
import { checklistAssignees } from "@/lib/holy-sheet-checklist-tasks";

export const GET = handle(async (req: Request, context: { params: Promise<{ projectId: string }> }) => {
  const { user } = await holySheetSuiteActor(req);
  const { projectId } = await context.params;
  return Response.json(await checklistAssignees(user, projectId));
});
