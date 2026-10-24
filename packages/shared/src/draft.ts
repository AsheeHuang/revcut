import { z } from 'zod';
import type { DraftState } from './status';

export const DRAFT_STATE_TRANSITIONS = {
  idle: ['queued'],
  queued: ['analyzing', 'planning', 'failed'],
  analyzing: ['planning', 'failed'],
  planning: ['done', 'failed'],
  done: ['queued'],
  failed: ['queued'],
} as const satisfies Record<DraftState, readonly DraftState[]>;

export type DraftTransition = {
  [From in DraftState]: { from: From; to: (typeof DRAFT_STATE_TRANSITIONS)[From][number] };
}[DraftState];

export type BusyDraftState = Extract<DraftState, 'queued' | 'analyzing' | 'planning'>;

export function isDraftBusy(state: DraftState): state is BusyDraftState {
  return state === 'queued' || state === 'analyzing' || state === 'planning';
}

export const DraftBody = z.object({
  trackId: z.uuid(),
  startBeat: z.number().int().min(0).optional(),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .optional(),
});
export type DraftBody = z.infer<typeof DraftBody>;
