import type { Db } from '../db/client';

export type ApiDeps = {
  db: Db;
  dataDir: string;
  freeBytes: () => Promise<number>;
  enqueueIngest: (mediaId: string) => void;
  enqueueAnalyze: (trackId: string) => void;
};
