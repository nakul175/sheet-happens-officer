import { currentUser, publicUser } from "@/lib/auth";
import { handle } from "@/lib/http";

export const GET = handle(async () => Response.json({ user: publicUser(await currentUser()) }));
