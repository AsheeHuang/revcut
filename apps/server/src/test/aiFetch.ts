import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config';

export const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(repoRoot, 'fixtures', 'ai', name), 'utf8'));

export type SentRequest = { url: string; headers: Headers; body: Record<string, unknown> };

// A fetch that answers each call with the next canned response and keeps what was sent.
export function replay(responses: (() => Response)[]) {
  const sent: SentRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = responses[sent.length - 1];
    if (!next) throw new Error(`no canned response for request ${sent.length}`);
    return next();
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Block = { type: string; text?: string; signature?: string };

// Replays a Messages API response as the SSE events the API streams for it. message_start names
// startModel, as it does when a fallback happens mid-stream.
export function sse(message: Record<string, unknown>, startModel = message.model) {
  const usage = message.usage as Record<string, unknown>;
  const content = message.content as Block[];
  const events: [string, unknown][] = [
    [
      'message_start',
      { type: 'message_start', message: { ...message, model: startModel, content: [], stop_reason: null, stop_details: null, usage: { ...usage, output_tokens: 1, iterations: null } } },
    ],
  ];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: block }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details },
      usage,
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
