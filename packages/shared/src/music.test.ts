import { describe, expect, expectTypeOf, it } from 'vitest';
import { isMusicExtension, type MusicTransition, PatchMusicBody, titleFromFilename } from './music';

describe('music files', () => {
  it.each(['song.mp3', 'a.M4A', 'b.aac', 'c.wav', 'd.FLAC'])('accepts %s', (filename) => {
    expect(isMusicExtension(filename)).toBe(true);
  });

  it.each(['clip.mov', 'song.ogg', 'no-extension', 'constructor'])('rejects %s', (filename) => {
    expect(isMusicExtension(filename)).toBe(false);
  });

  it('titles a track with its filename minus the extension', () => {
    expect(titleFromFilename('John Mayer - New Light.mp3')).toBe('John Mayer - New Light');
    expect(titleFromFilename('a.b.flac')).toBe('a.b');
    expect(titleFromFilename('noext')).toBe('noext');
  });
});

describe('music status', () => {
  it('allows only the transitions of the state machine', () => {
    expectTypeOf({ from: 'uploaded', to: 'analyzing' } as const).toExtend<MusicTransition>();
    expectTypeOf({ from: 'analyzing', to: 'ready' } as const).toExtend<MusicTransition>();
    expectTypeOf({ from: 'analyzing', to: 'failed' } as const).toExtend<MusicTransition>();
    expectTypeOf({ from: 'analyzing', to: 'uploaded' } as const).toExtend<MusicTransition>();
    expectTypeOf({ from: 'failed', to: 'uploaded' } as const).toExtend<MusicTransition>();
    expectTypeOf({ from: 'ready', to: 'analyzing' } as const).not.toExtend<MusicTransition>();
    expectTypeOf({ from: 'failed', to: 'analyzing' } as const).not.toExtend<MusicTransition>();
  });
});

describe('PatchMusicBody', () => {
  it('trims the title and clears a blank artist', () => {
    expect(PatchMusicBody.parse({ title: '  New Light ', artist: '  ' })).toEqual({ title: 'New Light', artist: null });
  });

  it('rejects a blank title', () => {
    expect(PatchMusicBody.safeParse({ title: ' ' }).success).toBe(false);
  });
});
