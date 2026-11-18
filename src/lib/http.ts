import { connection } from "next/server";
import { randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { reqCtx, type ReqCtx } from "@/lib/reqctx";
import { isVersionCode, versionErrorBody } from "@/lib/version-error";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, `${what} not found`);

/** Parse a JSON body against a schema; throws ApiError(400) on failure. */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "Body must be valid JSON");
  }
  return schema.parse(raw);
}

export function parseQuery<T>(url: URL, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(url.searchParams));
}

/**
 * APL-2670: version failures on edit, assign, move, complete and setApprover
 * are exactly { error: { code, message } }. Other errors keep the shared shape,
 * so a shared operation that throws the same ApiError still carries who changed the task.
 */
export function withVersionErrors<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError && isVersionCode(err.code)) {
        return Response.json(versionErrorBody(err.code, err.message), { status: err.status });
      }
      throw err;
    }
  };
}

/** Wrap a handler so thrown ApiError / ZodError / Prisma errors become JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    await connection(); // every API answer is per request; nothing is prerendered at build time
    const ctx: ReqCtx = {};
    try {
      const res = await reqCtx.run(ctx, () => fn(...args));
      // The Undo toast needs to know which action this call logged (SHO-US-6.4).
      if (ctx.undoId && res.status < 300) {
        try {
          res.headers.set("x-undo-id", ctx.undoId);
          res.headers.set("x-undo-label", ctx.undoLabel ?? "Done");
          if (ctx.notified) res.headers.set("x-undo-notified", "1");
        } catch { /* immutable headers: no toast */ }
      }
      return res;
    } catch (err) {
      if (err instanceof ApiError) {
        return Response.json({ error: err.message, ...err.extra }, { status: err.status });
      }
      if (err instanceof ZodError) {
        return Response.json(
          { error: "Validation failed", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) },
          { status: 400 },
        );
      }
      const code = (err as { code?: string })?.code;
      if (code === "P2002") return Response.json({ error: "That already exists" }, { status: 409 });
      if (/at most 8 sections/.test(String((err as Error)?.message))) {
        return Response.json({ error: "A project can have up to 8 sections." }, { status: 409 });
      }
      if (code === "P2025") return Response.json({ error: "Resource not found" }, { status: 404 });
      if (code === "P2003") return Response.json({ error: "Referenced record does not exist" }, { status: 400 });
      // Keep only fixed-shape Prisma codes or SQLSTATEs. Raw-query failures
      // carry PostgreSQL's SQLSTATE in meta.code, so retain that safe category
      // alongside P2010 without logging the query or parameter values.
      const sqlstate = /^(?:08|22|23|25|28|40|42|53|55|57|58|XX)[0-9A-Z]{3}$/;
      const prismaCode = typeof code === "string" && /^P\d{4}$/.test(code) ? code : "";
      const directState = typeof code === "string" && sqlstate.test(code) ? code : "";
      const metaCode = (err as { meta?: { code?: unknown } })?.meta?.code;
      const nestedState = prismaCode === "P2010" && typeof metaCode === "string" && sqlstate.test(metaCode) ? metaCode : "";
      const safeCode = nestedState ? `${prismaCode}/${nestedState}` : prismaCode || directState;
      const errorId = randomUUID();
      console.error("unexpected error", safeCode || "UNKNOWN", errorId);
      return Response.json({ error: "Internal server error" }, { status: 500, headers: { "x-error-id": errorId } });
    }
  };
}
