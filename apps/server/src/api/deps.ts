import type { Db } from '../db/client';
import type { DraftRequest } from '../jobs/draft';

export type ApiDeps = {
  db: Db;
  dataDir: string;
  freeBytes: () => Promise<number>;
  enqueueIngest: (mediaId: string) => void;
  enqueueAnalyze: (trackId: string) => void;
  enqueueDraft: (request: DraftRequest) => void;
};
