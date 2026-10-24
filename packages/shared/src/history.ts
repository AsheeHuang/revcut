export const UNDO_LIMIT = 100;

// SPEC §11.3: undo lives only in the page. A gesture key folds a drag or a typed field into one step.
export type History<T> = { past: T[]; present: T; future: T[]; gesture: string | null };

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], gesture: null });

export function record<T>(history: History<T>, next: T, gesture: string | null = null): History<T> {
  if (next === history.present) return history;
  if (gesture !== null && gesture === history.gesture) return { ...history, present: next, future: [] };
  return { past: [...history.past, history.present].slice(-UNDO_LIMIT), present: next, future: [], gesture };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], gesture: null };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...future] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future, gesture: null };
}
