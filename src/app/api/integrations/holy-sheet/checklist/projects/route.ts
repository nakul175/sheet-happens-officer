import { handle } from "@/lib/http";
import { holySheetSuiteActor } from "@/lib/suite-oauth";
import { checklistDestinations } from "@/lib/holy-sheet-checklist-tasks";

export const GET = handle(async (req: Request) => {
  const { user } = await holySheetSuiteActor(req);
  return Response.json(await checklistDestinations(user));
});
