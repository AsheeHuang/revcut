import { describe, expect, expectTypeOf, it } from 'vitest';
import { extensionOf, isMediaBusy, kindFromExtension, type MediaTransition } from './media';

describe('kindFromExtension', () => {
  it.each([
    ['IMG_1234.MOV', 'video'],
    ['clip.mp4', 'video'],
    ['IMG_1234.HEIC', 'photo'],
    ['a.heif', 'photo'],
    ['a.JPG', 'photo'],
    ['a.jpeg', 'photo'],
    ['screen.png', 'photo'],
  ])('accepts %s as %s', (filename, kind) => {
    expect(kindFromExtension(extensionOf(filename))).toBe(kind);
  });

  it.each(['song.mp3', 'doc.pdf', 'archive.tar.gz', 'no-extension', 'heic'])('rejects %s', (filename) => {
    expect(kindFromExtension(extensionOf(filename))).toBeNull();
  });

  it('does not treat inherited object keys as extensions', () => {
    expect(kindFromExtension('constructor')).toBeNull();
  });
});

describe('media status', () => {
  it('counts uploaded and processing as busy, ready and failed as settled', () => {
    expect((['uploaded', 'processing', 'ready', 'failed'] as const).map(isMediaBusy)).toEqual([true, true, false, false]);
  });

  it('allows only the transitions of the state machine', () => {
    expectTypeOf({ from: 'uploaded', to: 'processing' } as const).toExtend<MediaTransition>();
    expectTypeOf({ from: 'processing', to: 'uploaded' } as const).toExtend<MediaTransition>();
    expectTypeOf({ from: 'failed', to: 'uploaded' } as const).toExtend<MediaTransition>();
    expectTypeOf({ from: 'ready', to: 'processing' } as const).not.toExtend<MediaTransition>();
    expectTypeOf({ from: 'failed', to: 'processing' } as const).not.toExtend<MediaTransition>();
  });
});
