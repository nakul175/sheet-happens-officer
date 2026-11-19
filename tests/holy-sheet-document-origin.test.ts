import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(async () => ({ id: 'signed-in-user' })),
  changeDocument: vi.fn(async () => ({ linked: true })),
}));
vi.mock('@/lib/auth', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/http', () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, message: string) { super(message); } },
  parseBody: async (request: Request) => request.json(),
  handle: (fn: () => Promise<Response>) => async () => {
    try { return await fn(); }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { status?: number }).status ?? 500 }); }
  },
}));
vi.mock('@/lib/holy-sheet-links', () => ({
  documents: vi.fn(),
  changeDocument: mocks.changeDocument,
}));

import * as projectRoute from '../src/app/api/projects/[id]/documents/route';
import * as taskRoute from '../src/app/api/tasks/[id]/documents/route';

afterEach(() => { vi.unstubAllEnvs(); mocks.changeDocument.mockClear(); });

function request(host: string, origin: string) {
  return new Request(`https://${host}/api/projects/p/documents`, {
    method: 'POST',
    headers: { host, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'central-user', pageId: '11111111-1111-4111-8111-111111111111' }),
  });
}

it.each([
  ['project', projectRoute.POST],
  ['task', taskRoute.POST],
] as const)('%s document route accepts canonical same-origin writes and denies cross-host writes', async (_, post) => {
  vi.stubEnv('SHO_HOLY_QA', '0');
  const context = { params: Promise.resolve({ id: 'source-id' }) };
  const allowed = await post(request('tasks.aplyd.org', 'https://tasks.aplyd.org'), context);
  expect(allowed.status).toBe(200);
  const legacy = await post(request('sheethappensofficer.aplyd.org', 'https://sheethappensofficer.aplyd.org'), context);
  expect(legacy.status).toBe(200);
  expect(mocks.changeDocument).toHaveBeenCalledTimes(2);

  const crossHost = await post(request('tasks.aplyd.org', 'https://sheethappensofficer.aplyd.org'), context);
  expect(crossHost.status).toBe(403);
  const foreign = await post(request('evil.invalid', 'https://evil.invalid'), context);
  expect(foreign.status).toBe(403);
  expect(mocks.changeDocument).toHaveBeenCalledTimes(2);
});
