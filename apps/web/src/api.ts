import { ApiError } from '@revcut/shared';

type Schema<T> = { parse: (value: unknown) => T };

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function toRequestError(status: number, body: unknown): RequestError {
  const parsed = ApiError.safeParse(body);
  if (parsed.success) return new RequestError(status, parsed.data.error.code, parsed.data.error.message);
  return new RequestError(status, 'UNKNOWN', `伺服器回應 ${status}`);
}

export async function api<T>(schema: Schema<T>, url: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init.body),
    }),
  });
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw toRequestError(res.status, body);
  return schema.parse(body);
}

export const noContent: Schema<null> = { parse: () => null };

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
