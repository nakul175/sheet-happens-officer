import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { myTasks } from "@/lib/tasks";

export const GET = handle(async () => Response.json(await myTasks(await currentUser())));
