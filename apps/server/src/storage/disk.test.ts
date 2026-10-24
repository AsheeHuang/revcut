import { describe, expect, it } from 'vitest';
import { smallestFreeBytes } from './disk';

describe('smallestFreeBytes', () => {
  it('takes the smaller free space of the two filesystems', () => {
    const wslDisk = { bavail: 1000, bsize: 4096 };
    const hostDrive = { bavail: 10, bsize: 4096 };
    expect(smallestFreeBytes([wslDisk, hostDrive])).toBe(40960);
    expect(smallestFreeBytes([hostDrive, wslDisk])).toBe(40960);
  });

  it('compares bytes, not blocks', () => {
    expect(smallestFreeBytes([{ bavail: 100, bsize: 512 }, { bavail: 20, bsize: 4096 }])).toBe(51200);
  });
});
