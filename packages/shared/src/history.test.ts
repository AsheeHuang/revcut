import { describe, expect, it } from 'vitest';
import { record, redo, startHistory, UNDO_LIMIT, undo } from './history';

describe('edit history', () => {
  it('undoes and redoes edits in order', () => {
    let history = startHistory('a');
    history = record(history, 'b');
    history = record(history, 'c');
    history = undo(history);
    expect(history.present).toBe('b');
    history = undo(history);
    expect(history.present).toBe('a');
    history = redo(history);
    expect(history.present).toBe('b');
    history = redo(history);
    expect(history.present).toBe('c');
  });

  it('leaves the history alone when there is nothing to undo or redo', () => {
    const history = startHistory('a');
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it('drops the redo steps when a new edit follows an undo', () => {
    let history = record(record(startHistory('a'), 'b'), 'c');
    history = record(undo(history), 'd');
    expect(redo(history).present).toBe('d');
    expect(undo(history).present).toBe('b');
  });

  it('does not record an edit that changed nothing', () => {
    const history = record(startHistory('a'), 'b');
    expect(record(history, 'b')).toBe(history);
  });

  it(`keeps only the last ${UNDO_LIMIT} steps`, () => {
    let history = startHistory(0);
    for (let i = 1; i <= UNDO_LIMIT + 20; i++) history = record(history, i);
    for (let i = 0; i < UNDO_LIMIT + 20; i++) history = undo(history);
    expect(history.present).toBe(20);
  });

  it('folds a continuous gesture into one undo step', () => {
    let history = record(startHistory('a'), 'b');
    history = record(history, 'b1', 'drag-1');
    history = record(history, 'b2', 'drag-1');
    history = record(history, 'b3', 'drag-1');
    expect(undo(history).present).toBe('b');
  });

  it('starts a new step for the next gesture, even on the same control', () => {
    let history = record(startHistory('a'), 'b', 'drag-1');
    history = record(history, 'c', 'drag-2');
    expect(undo(history).present).toBe('b');
    history = record(undo(history), 'd', 'drag-2');
    expect(undo(history).present).toBe('b');
  });
});
