import { describe, expect, it } from 'vitest';
import { previewSize } from './derive';

describe('previewSize', () => {
  it.each([
    [2160, 3840, 720, 1280],
    [1080, 1920, 720, 1280],
    [1920, 1080, 1280, 720],
    [1440, 1080, 960, 720],
  ])('scales %ix%i to a 720 short edge: %ix%i', (w, h, ew, eh) => {
    expect(previewSize(w, h)).toEqual({ width: ew, height: eh });
  });

  it('never upscales, and keeps both sides even', () => {
    expect(previewSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(previewSize(641, 481)).toEqual({ width: 642, height: 482 });
  });
});
