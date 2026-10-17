import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { dismissStartGuide } from "@/lib/orientation";

export const POST = handle(async () => Response.json(await dismissStartGuide(await currentUser())));
