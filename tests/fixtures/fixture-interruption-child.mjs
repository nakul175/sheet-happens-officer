// Deliberately stop after a committed fixture write, before any teardown can run.
import { PrismaClient } from '@prisma/client';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/invalid');
const [workspaceId, name] = process.argv.slice(2);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/sho_test' || !workspaceId || !/^zz-interrupt-[0-9a-f-]+-[12]$/.test(name ?? '')) {
  process.stderr.write('DISPOSABLE_LOCAL_SHO_TEST_REQUIRED\n');
  process.exit(2);
}

const db = new PrismaClient();
try {
  const project = await db.project.create({ data: { workspaceId, name } });
  process.stdout.write(`${JSON.stringify({ id: project.id })}\n`, () => process.kill(process.pid, 'SIGKILL'));
} catch {
  process.stderr.write('CHILD_CREATE_FAILED\n');
  process.exit(3);
}
