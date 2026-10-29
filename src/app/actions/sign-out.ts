"use server";

import { redirect, RedirectType } from "next/navigation";
import { audit, endSession } from "@/lib/auth";

/** Mutating the session cookie in a Server Action also invalidates Next's client cache. */
export async function signOut() {
  const userId = await endSession();
  if (userId) await audit("SIGN_OUT", { actorId: userId });
  redirect("/signin", RedirectType.replace);
}
