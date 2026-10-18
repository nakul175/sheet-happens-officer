import { connection } from "next/server";

// Which build is running (process v3 P2). RELEASE and ARTIFACT_SHA256 come from release.env,
// written by deploy/release.sh and loaded by the service. Neither value is a secret.
// connection() keeps the read at request time so the build does not bake in empty values.
export async function GET() {
  await connection();
  const sha = process.env.RELEASE || null;
  const digest = process.env.ARTIFACT_SHA256 || null;
  return Response.json({ sha, digest }, { headers: { "cache-control": "no-store" } });
}
