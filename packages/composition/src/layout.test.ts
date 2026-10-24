import { describe, expect, it } from 'vitest';
import { coverRect, kenBurnsZoom } from './layout';

const center = { focusX: 0.5, focusY: 0.5, zoom: 1 };

describe('coverRect', () => {
  it('fills the frame exactly with a 9:16 source', () => {
    expect(coverRect(1080, 1920, center)).toEqual({ left: 0, top: 0, width: 1080, height: 1920 });
  });

  it('lays out the 720p preview and the 4K original the same way', () => {
    const crop = { focusX: 0.3, focusY: 0.7, zoom: 1.4 };
    const preview = coverRect(720, 1280, crop);
    const original = coverRect(2160, 3840, crop);
    for (const key of ['left', 'top', 'width', 'height'] as const) expect(preview[key]).toBeCloseTo(original[key], 9);
  });

  it('covers the height of a landscape source and centers its focus', () => {
    const rect = coverRect(1920, 1080, center);
    expect(rect.height).toBeCloseTo(1920, 9);
    expect(rect.width).toBeCloseTo(3413.333, 3);
    expect(rect.left).toBeCloseTo(540 - 3413.333 / 2, 3);
    expect(rect.top).toBe(0);
  });

  it('never shows past the edge of the source', () => {
    expect(coverRect(1920, 1080, { ...center, focusX: 0 }).left).toBe(0);
    expect(coverRect(1920, 1080, { ...center, focusX: 1 }).left).toBeCloseTo(1080 - 3413.333, 3);
    expect(coverRect(1080, 1920, { focusX: 0.1, focusY: 0.95, zoom: 2 })).toEqual({ left: 0, top: -1920, width: 2160, height: 3840 });
  });

  it('puts the focus in the middle once zoomed in far enough', () => {
    expect(coverRect(1080, 1920, { focusX: 0.5, focusY: 0.5, zoom: 2 })).toEqual({ left: -540, top: -960, width: 2160, height: 3840 });
  });
});

describe('kenBurnsZoom', () => {
  it('runs linearly from the crop zoom on the first frame to the end zoom on the last', () => {
    expect(kenBurnsZoom(0, 31, 1, 1.08)).toBe(1);
    expect(kenBurnsZoom(15, 31, 1, 1.08)).toBeCloseTo(1.04, 9);
    expect(kenBurnsZoom(30, 31, 1, 1.08)).toBeCloseTo(1.08, 9);
  });

  it('holds the crop zoom for a single-frame clip', () => {
    expect(kenBurnsZoom(0, 1, 1.2, 1.5)).toBe(1.2);
  });
});
