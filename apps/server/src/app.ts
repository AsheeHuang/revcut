import { type ApiError, HealthResponse } from '@revcut/shared';
import Fastify, { type FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { type HealthChecks, runHealthChecks } from './health';

const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function apiError(code: string, message: string, details?: unknown): ApiError {
  return { error: { code, message, details } };
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function buildApp({ checks, logger = false }: { checks: HealthChecks; logger?: boolean }) {
  const app = Fastify({ logger }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // DNS rebinding guard (SPEC §2.4): a hostile page can resolve its own name to 127.0.0.1.
  app.addHook('onRequest', async (request, reply) => {
    if (!ALLOWED_HOSTNAMES.has(request.hostname)) {
      return reply.code(403).send(apiError('FORBIDDEN_HOST', '只接受 Host 為 localhost 或 127.0.0.1 的請求'));
    }
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(apiError('NOT_FOUND', `找不到 ${request.method} ${request.url}`)),
  );

  app.setErrorHandler<FastifyError | HttpError>((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send(apiError(error.code, error.message, error.details));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', '請求格式錯誤', error.validation));
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send(apiError(error.code, error.message));
    }
    request.log.error(error);
    return reply.code(500).send(apiError('INTERNAL', '伺服器錯誤'));
  });

  app.get('/api/health', { schema: { response: { 200: HealthResponse } } }, () => runHealthChecks(checks));

  return app;
}
