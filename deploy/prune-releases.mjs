import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;

/** Remove only old, complete release trees; never act on a reservation or an unknown directory. */
export async function pruneReleases(root, active, previous, keep = 3) {
  const base = path.resolve(root);
  if (await realpath(base) !== base) throw new Error('RELEASE_PARENT_INVALID');
  if (!Number.isSafeInteger(keep) || keep < 2) throw new Error('RETENTION_INVALID');
  for (const protectedPath of [active, previous]) {
    if (path.dirname(protectedPath) !== base || !SHA.test(path.basename(protectedPath))) {
      throw new Error('PROTECTED_RELEASE_INVALID');
    }
  }
  if (await realpath(path.join(base, '..', 'current')) !== active) throw new Error('ACTIVE_RELEASE_CHANGED');

  const complete = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SHA.test(entry.name)) continue;
    const dir = path.join(base, entry.name);
    const stat = await lstat(dir);
    if (!stat.isDirectory()) continue;
    try {
      if (!(await lstat(path.join(dir, 'COMMIT'))).isFile()) continue;
      if (!(await lstat(path.join(dir, '.next/BUILD_ID'))).isFile()) continue;
      if ((await readFile(path.join(dir, 'COMMIT'), 'utf8')).trim() !== entry.name) continue;
      if (!(await readFile(path.join(dir, '.next/BUILD_ID'), 'utf8')).trim()) continue;
    } catch { continue; } // An incomplete upload or build needs separate operator review.
    complete.push({ dir, name: entry.name, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
  }
  if (![active, previous].every((p) => complete.some((r) => r.dir === p))) throw new Error('PROTECTED_RELEASE_INCOMPLETE');
  complete.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const protectedPaths = new Set([active, previous, ...complete.slice(0, keep).map((r) => r.dir)]);
  const removed = [];
  for (const candidate of complete) {
    if (protectedPaths.has(candidate.dir)) continue;
    const now = await lstat(candidate.dir);
    if (!now.isDirectory() || now.dev !== candidate.dev || now.ino !== candidate.ino) throw new Error('RELEASE_CHANGED_DURING_PRUNE');
    await rm(candidate.dir, { recursive: true });
    removed.push(candidate.name);
  }
  return { retained: complete.length - removed.length, removed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, active, previous, rawKeep] = process.argv.slice(2);
  pruneReleases(root, active, previous, Number(rawKeep))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => { console.error('RELEASE_PRUNE_DEFERRED'); process.exitCode = 1; });
}
