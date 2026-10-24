import { describe, expect, it } from 'vitest';
import { groupLivePhotos, type LiveGroupable } from './livePhoto';

type Item = LiveGroupable & { id: string };

const base = { status: 'ready', contentIdentifier: null, capturedAt: null, lat: null, lng: null } as const;

const heic = (id: string, overrides: Partial<Item> = {}): Item => ({ ...base, id, kind: 'photo', ...overrides });
const mov = (id: string, overrides: Partial<Item> = {}): Item => ({ ...base, id, kind: 'video', ...overrides });

const ids = (items: { id: string; livePhoto: boolean }[]) => items.map((m) => [m.id, m.livePhoto]);

describe('groupLivePhotos', () => {
  it('shows a pair as one LIVE video once the video is ready', () => {
    const items = [heic('photo', { contentIdentifier: 'A' }), mov('video', { contentIdentifier: 'A' })];
    expect(ids(groupLivePhotos(items))).toEqual([['video', true]]);
  });

  it.each(['uploaded', 'processing', 'failed'] as const)('keeps the photo while the video is %s', (status) => {
    const items = [heic('photo', { contentIdentifier: 'A' }), mov('video', { contentIdentifier: 'A', status })];
    expect(ids(groupLivePhotos(items))).toEqual([
      ['photo', false],
      ['video', false],
    ]);
  });

  it('treats a HEIC without its MOV as a plain photo', () => {
    expect(ids(groupLivePhotos([heic('photo', { contentIdentifier: 'A' })]))).toEqual([['photo', false]]);
  });

  it('only pairs media that share the same identifier', () => {
    const items = [heic('photo', { contentIdentifier: 'A' }), mov('video', { contentIdentifier: 'B' }), heic('plain')];
    expect(ids(groupLivePhotos(items))).toEqual([
      ['photo', false],
      ['video', false],
      ['plain', false],
    ]);
  });

  it('fills the video’s missing capture time and GPS from its photo', () => {
    const photo = heic('photo', {
      contentIdentifier: 'A',
      capturedAt: '2026-10-03T14:22:10+08:00',
      lat: 25.026,
      lng: 121.543,
    });
    const [video] = groupLivePhotos([photo, mov('video', { contentIdentifier: 'A' })]);
    expect(video).toMatchObject({
      id: 'video',
      capturedAt: '2026-10-03T14:22:10+08:00',
      lat: 25.026,
      lng: 121.543,
    });
  });

  it('keeps the video’s own values when it has them', () => {
    const photo = heic('photo', { contentIdentifier: 'A', capturedAt: '2026-10-03T14:22:10+08:00', lat: 1, lng: 2 });
    const video = mov('video', { contentIdentifier: 'A', capturedAt: '2026-10-03T14:22:11+08:00', lat: 3, lng: 4 });
    expect(groupLivePhotos([photo, video])[0]).toMatchObject({ capturedAt: '2026-10-03T14:22:11+08:00', lat: 3, lng: 4 });
  });

  it('keeps media without an identifier in their original order', () => {
    expect(ids(groupLivePhotos([mov('a'), heic('b'), mov('c')]))).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
    ]);
  });
});
