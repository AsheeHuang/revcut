import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRenderBusy, type RenderTransition } from './render';

describe('render state', () => {
  it('counts queued, preparing and rendering as busy', () => {
    expect((['queued', 'preparing', 'rendering', 'done', 'failed'] as const).map(isRenderBusy)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('allows only the transitions of the state machine', () => {
    expectTypeOf({ from: 'queued', to: 'preparing' } as const).toExtend<RenderTransition>();
    expectTypeOf({ from: 'preparing', to: 'rendering' } as const).toExtend<RenderTransition>();
    expectTypeOf({ from: 'rendering', to: 'done' } as const).toExtend<RenderTransition>();
    expectTypeOf({ from: 'rendering', to: 'queued' } as const).toExtend<RenderTransition>();
    expectTypeOf({ from: 'done', to: 'queued' } as const).not.toExtend<RenderTransition>();
    expectTypeOf({ from: 'queued', to: 'rendering' } as const).not.toExtend<RenderTransition>();
  });
});
