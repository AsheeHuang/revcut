import path from 'node:path';

export type MediaFile = { projectId: string; id: string; ext: string };

export function projectDir(dataDir: string, projectId: string): string {
  return path.join(dataDir, 'projects', projectId);
}

// SPEC §5.1: every path derives from ids and the extension; nothing is stored in the database.
export function mediaPaths(dataDir: string, media: MediaFile) {
  const project = projectDir(dataDir, media.projectId);
  const derived = path.join(project, 'derived', media.id);
  return {
    original: path.join(project, 'originals', `${media.id}.${media.ext}`),
    derived,
    derivedTmp: `${derived}.tmp`,
    preview: path.join(derived, 'preview.mp4'),
    photo: path.join(derived, 'photo.jpg'),
    thumb: path.join(derived, 'thumb.webp'),
  };
}

export function musicPaths(dataDir: string, track: { id: string; ext: string }) {
  const dir = path.join(dataDir, 'music');
  const tmp = path.join(dir, `${track.id}.tmp`);
  return { file: path.join(dir, `${track.id}.${track.ext}`), tmp, wav: path.join(tmp, 'song.wav') };
}

// SPEC §5.1: slices and the unfinished MP4 live in renders/{renderId}.tmp/ until the render is done.
export function renderPaths(dataDir: string, projectId: string, renderId: string) {
  const dir = path.join(projectDir(dataDir, projectId), 'renders');
  const tmp = path.join(dir, `${renderId}.tmp`);
  return {
    output: path.join(dir, `${renderId}.mp4`),
    tmp,
    draft: path.join(tmp, 'out.mp4'),
    slice: (clipId: string) => path.join(tmp, `${clipId}.mp4`),
  };
}
