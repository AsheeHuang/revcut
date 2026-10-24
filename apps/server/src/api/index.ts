import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from './deps';
import { mediaRoutes } from './media';
import { musicRoutes } from './music';
import { projectRoutes } from './projects';

export type { ApiDeps } from './deps';

export const apiRoutes: FastifyPluginAsyncZod<ApiDeps> = async (app, deps) => {
  await app.register(projectRoutes, deps);
  await app.register(mediaRoutes, deps);
  await app.register(musicRoutes, deps);
};
