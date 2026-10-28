// Storage-neutral contract. A production adapter requires NJ's store/region/retention decision.
import { ApiError } from "@/lib/http";
export interface AttachmentStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Idempotent; resolving means the object is gone. Failure must reject. */
  remove(key: string): Promise<void>;
}
const objects = new Map<string, Uint8Array>();
const stub: AttachmentStore = {
  async put(key, bytes) { objects.set(key, bytes.slice()); },
  async get(key) { return objects.get(key)?.slice() ?? null; },
  async remove(key) { objects.delete(key); },
};
export function attachmentStore(): AttachmentStore {
  // Even an accidental flag-on cannot enable this ephemeral stub in production.
  if (process.env.NODE_ENV === "production" || process.env.ATTACHMENT_STORE !== "test-stub") {
    throw new ApiError(503, "Attachment storage is not configured. This feature is awaiting a storage decision.");
  }
  return stub;
}
