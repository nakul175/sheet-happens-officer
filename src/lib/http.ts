import { connection } from "next/server";
import { ZodError, type ZodType } from "zod";
import { reqCtx, type ReqCtx } from "@/lib/reqctx";
import {
  INVALID_VERSION, INVALID_VERSION_MESSAGE, VERSION_REQUIRED, VERSION_REQUIRED_MESSAGE,
  isVersionCode, versionErrorBody, versionProblem,
} from "@/lib/version-error";

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
  return schema.parse(await readJson(req));
}

function versionApiError(code: typeof VERSION_REQUIRED | typeof INVALID_VERSION): ApiError {
  if (code === INVALID_VERSION) return new ApiError(400, INVALID_VERSION_MESSAGE, undefined, code);
  return new ApiError(400, VERSION_REQUIRED_MESSAGE, undefined, VERSION_REQUIRED);
}

/**
 * APL-2670: task edits, assign, move, complete and setApprover.
 * A missing or null version, and an empty-string version, are answered here — before the
 * schema — so every route returns the same body instead of a Zod issues list or a plain string.
 */
export async function parseTaskBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw = await readJson(req);
  const problem = versionProblem(raw);
  if (problem) throw versionApiError(problem);
  return schema.parse(raw);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "Body must be valid JSON");
  }
}

/**
 * Turn a version ApiError into the one body { error: { code, message } }.
 * Other errors are rethrown so the shared handler keeps their existing shape.
 * Only the task mutation routes use this: a concierge confirm that hits the same
 * check still carries who changed the card.
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

export function parseQuery<T>(url: URL, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(url.searchParams));
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
      // Name and database code only: an error's message or fields can carry chat or task text.
      console.error("unexpected error", (err as Error)?.name ?? typeof err, code ?? "");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
