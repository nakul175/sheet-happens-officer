import { handle, parseBody } from "@/lib/http";
import { holySheetSuiteActor } from "@/lib/suite-oauth";
import { checklistCreateInput, createChecklistTask } from "@/lib/holy-sheet-checklist-tasks";

export const POST = handle(async (req: Request) => {
  const { user, subject } = await holySheetSuiteActor(req);
  const { reviewToken } = await parseBody(req, checklistCreateInput);
  const result = await createChecklistTask(user, subject, reviewToken);
  return Response.json(result, { status: result.created ? 201 : 200 });
});
