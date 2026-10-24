import type { AiProviders } from '../ai/providers';
import type { Db } from '../db/client';
import type { DraftRequest } from '../jobs/draft';

export type ApiDeps = {
  db: Db;
  dataDir: string;
  ai: AiProviders;
  freeBytes: () => Promise<number>;
  enqueueIngest: (mediaId: string) => void;
  enqueueAnalyze: (trackId: string) => void;
  enqueueDraft: (request: DraftRequest) => void;
  enqueueRender: (renderId: string) => void;
};
