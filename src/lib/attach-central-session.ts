import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

export async function attachCentralSession(sourceSessionId: string, userId: string, subject: string, sessionUid: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = await db.$transaction(async tx => {
    const session = await tx.session.findUnique({ where: { id: sourceSessionId }, include: { user: true, centralLink: true } });
    const user = session?.user;
    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= new Date() ||
        !user || user.deactivatedAt || !user.emailVerifiedAt || user.tempPasswordAt ||
        (session.centralLink && session.centralLink.subject !== subject)) throw new Error("Source session unavailable");
    const changed = await tx.session.updateMany({ where: { id: sourceSessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { tokenHash: createHash("sha256").update(token).digest("hex") } });
    if (changed.count !== 1) throw new Error("Source session changed");
    await tx.centralSessionLink.upsert({ where: { sessionId: sourceSessionId },
      create: { sessionId: sourceSessionId, subject, sessionUid }, update: { sessionUid } });
    return session.expiresAt;
  });
  (await cookies()).set("sho_session", token, { httpOnly: true, sameSite: "lax", path: "/", expires,
    secure: process.env.NODE_ENV === "production" });
}
