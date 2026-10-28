import { handle, parseBody } from "@/lib/http";
import { holySheetSuiteActor } from "@/lib/suite-oauth";
import { checklistReviewInput, reviewChecklistTask } from "@/lib/holy-sheet-checklist-tasks";

export const POST = handle(async (req: Request) => {
  const { user, subject, grant } = await holySheetSuiteActor(req);
  return Response.json(await reviewChecklistTask(user, subject, await parseBody(req, checklistReviewInput), grant.clientId));
});
