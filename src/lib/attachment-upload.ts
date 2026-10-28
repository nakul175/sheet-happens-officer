import { ApiError } from "@/lib/http";
import { ATTACHMENT_MAX_BYTES } from "@/lib/attachments";
/** Bound chunked requests too: never buffer an unlimited multipart body before inspecting File.size. */
export async function attachmentForm(req: Request) {
  const max = ATTACHMENT_MAX_BYTES + 65536;
  if (Number(req.headers.get("content-length") ?? 0) > max) throw new ApiError(400, "Choose a PDF of up to 25 MB.", { code: "file_too_large" });
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data;") || !req.body) throw new ApiError(400, "Choose one PDF file.");
  const reader = req.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) { await reader.cancel(); throw new ApiError(400, "Choose a PDF of up to 25 MB.", { code: "file_too_large" }); }
      chunks.push(Buffer.from(chunk.value));
    }
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": type } }).formData();
  } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(400, "The upload could not be read. Choose one PDF file."); }
  finally { reader.releaseLock(); }
}
