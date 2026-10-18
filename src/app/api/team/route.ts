import { currentUser } from "@/lib/auth";
import { handle, parseBody } from "@/lib/http";
import { addPersonInput } from "@/lib/schemas";
import { addPerson, listTeam } from "@/lib/team";

export const GET = handle(async () => Response.json({ people: await listTeam(await currentUser()) }));

// SHO-US-15.2. Super Admin only; the check lives in addPerson.
export const POST = handle(async (req: Request) => {
  const me = await currentUser();
  const input = await parseBody(req, addPersonInput);
  return Response.json({ person: await addPerson(me, input) }, { status: 201 });
});
