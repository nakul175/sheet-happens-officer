import { z } from 'zod';
import { currentUser } from '@/lib/auth';
import { handle, parseBody, ApiError } from '@/lib/http';
import { documents, changeDocument } from '@/lib/holy-sheet-links';
const schema = z.object({ subject: z.string().min(1).max(200), setDefault: z.boolean().optional(), pageId: z.string().uuid(), spaceId: z.string().min(1).max(200).optional(), created: z.boolean().optional() }).strict();
type Context = {
    params: Promise<{
        id: string;
    }>;
};
function privateResponse(fn: () => Promise<Response>) { return handle(fn)().then(r => { r.headers.set('Cache-Control', 'private, no-store'); return r; }); }
export const GET = (req: Request, ctx: Context) => privateResponse(async () => Response.json(await documents(await currentUser(), { kind: 'tasks', id: (await ctx.params).id })));
async function mutate(req: Request, ctx: Context, remove: boolean) {
    return privateResponse(async () => {
        const actor = await currentUser();
        // Cookie-authenticated mutations require explicit same-origin browser intent.
        if (req.headers.get('origin') !== new URL(req.url).origin)
            throw new ApiError(403, 'Same-origin request required');
        const input = await parseBody(req, schema);
        return Response.json(await changeDocument(actor, { kind: 'tasks', id: (await ctx.params).id }, { ...input, remove }));
    });
}
export const POST = (req: Request, ctx: Context) => mutate(req, ctx, false);
export const DELETE = (req: Request, ctx: Context) => mutate(req, ctx, true);
