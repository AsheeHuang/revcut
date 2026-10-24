import { z } from 'zod';
import { RenderState } from './status';

export const RENDER_STATE_TRANSITIONS = {
  queued: ['preparing'],
  preparing: ['rendering', 'failed', 'queued'],
  rendering: ['done', 'failed', 'queued'],
  done: [],
  failed: [],
} as const satisfies Record<RenderState, readonly RenderState[]>;

export type RenderTransition = {
  [From in RenderState]: { from: From; to: (typeof RENDER_STATE_TRANSITIONS)[From][number] };
}[RenderState];

export function isRenderBusy(state: RenderState): boolean {
  return state === 'queued' || state === 'preparing' || state === 'rendering';
}

export const Render = z.object({
  id: z.uuid(),
  state: RenderState,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Render = z.infer<typeof Render>;

export const StartRenderResponse = z.object({ renderId: z.uuid() });
export type StartRenderResponse = z.infer<typeof StartRenderResponse>;
