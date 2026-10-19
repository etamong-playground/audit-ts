import { eventJSON, expiryMilliseconds, type DurableEvent } from './event.js';
import type { Acknowledgement, Sender } from './delivery.js';

export type CollectorOptions = { fetch?: typeof fetch; now?: () => number };
const maximumResponseBytes = 64 * 1024;

async function responseJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumResponseBytes)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Audit collector response exceeds limits');
  }
  if (!response.body) throw new Error('Audit collector response is empty');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximumResponseBytes) throw new Error('Audit collector response exceeds limits');
      if (value.byteLength > 0) chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Invalid audit collector JSON'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export function collectorSender(endpoint: string, token: string, options: CollectorOptions = {}): Sender {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error('Invalid audit collector configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    token.length < 32 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new Error('Invalid audit collector configuration');
  }
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return async (inputEvent, signal): Promise<Acknowledgement> => {
    const event = JSON.parse(eventJSON(inputEvent)) as DurableEvent;
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await request(url.href, { method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [event] }) });
    } catch { throw new Error('Audit collector request failed'); }
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Audit collector rejected ingestion');
    }
    let body: unknown;
    try { body = await responseJSON(response, signal); }
    catch { throw new Error('Invalid audit collector response'); }
    const acknowledgements = body && typeof body === 'object' && 'acknowledgements' in body ? body.acknowledgements : null;
    if (!Array.isArray(acknowledgements) || acknowledgements.length !== 1) throw new Error('Invalid audit acknowledgement');
    const ack = acknowledgements[0];
    if (!ack || ack.event_id !== event.event_id || !['accepted', 'expired'].includes(ack.disposition)) {
      throw new Error('Invalid audit acknowledgement');
    }
    if (ack.disposition === 'expired' && expiryMilliseconds(event.occurred_at) > now()) {
      throw new Error('Audit acknowledgement expired before retention');
    }
    return { event_id: event.event_id, disposition: ack.disposition };
  };
}
