import { mkdir, statfs } from 'node:fs/promises';

export const MIN_FREE_BYTES = 2 * 1024 ** 3;

type FsSpace = { bavail: number; bsize: number };

export function smallestFreeBytes(spaces: FsSpace[]): number {
  return Math.min(...spaces.map((space) => space.bavail * space.bsize));
}

// Inside WSL, statfs on DATA_DIR reports the virtual disk's maximum size, not
// what the Windows drive behind it still has (SPEC §5.3), so take the smaller.
export async function freeBytes(dataDir: string, hostDrive: string): Promise<number> {
  await mkdir(dataDir, { recursive: true });
  return smallestFreeBytes(await Promise.all([statfs(dataDir), statfs(hostDrive)]));
}
