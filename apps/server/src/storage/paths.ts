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
