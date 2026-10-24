import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

// SPEC §5.2: stream to a .part file while hashing, then rename into place.
// Any failure, including the client hanging up, leaves nothing behind.
export async function receiveFile(body: NodeJS.ReadableStream, target: string): Promise<{ sha256: string; sizeBytes: number }> {
  const part = `${target}.part`;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(body, tap, createWriteStream(part));
    await rename(part, target);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function removeEndingIn(dir: string, suffix: string): Promise<string[]> {
  const stray = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(suffix)).map((name) => path.join(dir, name));
  await Promise.all(stray.map((file) => rm(file, { recursive: true, force: true })));
  return stray;
}

// SPEC §6.1: on startup, nothing is writing, so every .part and .tmp left is from a crash.
export async function removeStrays(dataDir: string): Promise<string[]> {
  const removed: string[] = [];
  const projects = await readdir(path.join(dataDir, 'projects')).catch(() => []);
  for (const project of projects) {
    const dir = path.join(dataDir, 'projects', project);
    removed.push(...(await removeEndingIn(path.join(dir, 'originals'), '.part')));
    removed.push(...(await removeEndingIn(path.join(dir, 'derived'), '.tmp')));
  }
  return removed;
}

export async function removeMusicStrays(dataDir: string): Promise<string[]> {
  const dir = path.join(dataDir, 'music');
  return [...(await removeEndingIn(dir, '.part')), ...(await removeEndingIn(dir, '.tmp'))];
}
