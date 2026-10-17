import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { state } from "@/lib/concierge/thread";

export const GET = handle(async () => Response.json(await state(await currentUser())));
