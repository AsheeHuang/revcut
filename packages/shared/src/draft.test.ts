import { describe, expect, expectTypeOf, it } from 'vitest';
import { DraftBody, type DraftTransition, isDraftBusy } from './draft';

describe('draft state', () => {
  it('counts queued, analyzing and planning as busy', () => {
    expect((['idle', 'queued', 'analyzing', 'planning', 'done', 'failed'] as const).map(isDraftBusy)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('allows only the transitions of the state machine', () => {
    expectTypeOf({ from: 'idle', to: 'queued' } as const).toExtend<DraftTransition>();
    expectTypeOf({ from: 'queued', to: 'planning' } as const).toExtend<DraftTransition>();
    expectTypeOf({ from: 'planning', to: 'done' } as const).toExtend<DraftTransition>();
    expectTypeOf({ from: 'planning', to: 'failed' } as const).toExtend<DraftTransition>();
    expectTypeOf({ from: 'done', to: 'queued' } as const).toExtend<DraftTransition>();
    expectTypeOf({ from: 'idle', to: 'planning' } as const).not.toExtend<DraftTransition>();
    expectTypeOf({ from: 'done', to: 'planning' } as const).not.toExtend<DraftTransition>();
  });
});

describe('DraftBody', () => {
  it('needs a track and takes an optional start beat and 31-bit seed', () => {
    const trackId = '2265ce80-9035-4afb-9b6d-49ebf99f9f09';
    expect(DraftBody.parse({ trackId })).toEqual({ trackId });
    expect(DraftBody.safeParse({ trackId, seed: 2 ** 31 }).success).toBe(false);
    expect(DraftBody.safeParse({ trackId, startBeat: -1 }).success).toBe(false);
    expect(DraftBody.safeParse({}).success).toBe(false);
  });
});
