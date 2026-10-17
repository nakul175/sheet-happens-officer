import { currentUser } from "@/lib/auth";
import { handle } from "@/lib/http";
import { signOutOthers } from "@/lib/feed";

export const POST = handle(async () => Response.json({ signedOut: await signOutOthers(await currentUser()) }));
