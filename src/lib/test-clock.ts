import { createHmac, timingSafeEqual } from "node:crypto";

const NOW_HEADER = "x-sho-test-now";
const SIGNATURE_HEADER = "x-sho-test-clock-signature";

function localDatabase() {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function enabled() {
  return process.env.TEST_CLOCK === "1" && process.env.NODE_ENV !== "production" && localDatabase();
}

/**
 * A signed, local-only clock for story specs. Production and every remote database ignore it.
 * The signature is HMAC-SHA256(TEST_CLOCK_SECRET, the exact ISO timestamp header).
 */
export function requestNow(req: Request, fallback = Date.now()) {
  if (!enabled()) return fallback;
  const value = req.headers.get(NOW_HEADER) ?? "";
  const signature = req.headers.get(SIGNATURE_HEADER) ?? "";
  const secret = process.env.TEST_CLOCK_SECRET ?? "";
  if (secret.length < 16 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/^[a-f0-9]{64}$/i.test(signature)) return fallback;
  const expected = createHmac("sha256", secret).update(value).digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
