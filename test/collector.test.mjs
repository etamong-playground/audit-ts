import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectorSender } from '../dist/collector.js';

const endpoint = 'https://collector.example/v1/events';
const token = 'secret-test-'.repeat(4);
const event = { schema_version: 1, event_id: 'one', operation_id: 'op-one', service: 'probe', environment: 'test',
  occurred_at: '2026-10-19T00:00:00Z', actor: { type: 'job', id: 'cron' }, action: 'incident.open',
  target_type: 'incident', target_id: 'one', result: 'ok' };
const now = () => Date.parse(event.occurred_at);
const controller = () => new AbortController();
const response = (acks = [{ event_id: 'one', disposition: 'accepted' }]) => Response.json({ acknowledgements: acks });
const sender = fetch => collectorSender(endpoint, token, { fetch, now });

test('configuration rejects insecure or credential-bearing URLs and invalid bearer values', () => {
  for (const url of ['not a URL', 'http://collector.example/v1/events', 'https://user:password@collector.example/',
    endpoint + '?secret=value', endpoint + '#fragment']) assert.throws(() => collectorSender(url, token), /configuration/);
  for (const value of ['', 'a'.repeat(31), 'a'.repeat(4097), token + '\n', token + ' ', token + ':']) {
    assert.throws(() => collectorSender(endpoint, value), /configuration/);
  }
});

test('request uses exact ingestion envelope, bearer, redirect policy and cancellation signal', async () => {
  const abort = controller(); const calls = [];
  const send = sender(async (url, init) => { calls.push({ url, init }); return response(); });
  assert.deepEqual(await send(event, abort.signal), { event_id: 'one', disposition: 'accepted' });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, `Bearer ${token}`); assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.signal, abort.signal); assert.deepEqual(JSON.parse(init.body), { events: [event] });
});

test('invalid events and already-cancelled requests never call fetch', async () => {
  let calls = 0; const send = sender(async () => { calls++; return response(); });
  await assert.rejects(send({ ...event, actor: { id: 'bad', type: 'unknown' } }, controller().signal));
  const abort = controller(); abort.abort(); await assert.rejects(send(event, abort.signal)); assert.equal(calls, 0);
});

test('HTTP failure, redirect and fetch failures never expose response bodies or secrets', async () => {
  for (const status of [301, 302, 401, 403, 409, 429, 500]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(sender(async () => new Response(body, { status }))(event, controller().signal), /rejected ingestion/);
    assert.ok(cancelled);
  }
  const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(sender(async () => redirected)(event, controller().signal), /rejected ingestion/);
  await assert.rejects(sender(async () => { throw Error(token); })(event, controller().signal), error => !String(error).includes(token));
});

test('one matching accepted acknowledgement is required', async () => {
  for (const acks of [[], [{ event_id: 'one', disposition: 'accepted' }, { event_id: 'one', disposition: 'accepted' }],
    [{ event_id: 'other', disposition: 'accepted' }], [{ event_id: 'one', disposition: 'conflict' }], [null], {}, null]) {
    await assert.rejects(sender(async () => response(acks))(event, controller().signal), /acknowledgement/);
  }
  for (const body of [null, [], { unrelated: true }]) {
    await assert.rejects(sender(async () => Response.json(body))(event, controller().signal), /acknowledgement/);
  }
});

test('expired acknowledgement is accepted only at the original calendar deadline', async () => {
  const request = async () => response([{ event_id: 'one', disposition: 'expired' }]);
  await assert.rejects(sender(request)(event, controller().signal), /before retention/);
  const leap = { ...event, occurred_at: '2024-02-29T12:30:00Z' };
  const before = collectorSender(endpoint, token, { fetch: request, now: () => Date.parse('2026-02-28T12:29:59.999Z') });
  await assert.rejects(before(leap, controller().signal), /before retention/);
  const at = collectorSender(endpoint, token, { fetch: request, now: () => Date.parse('2026-02-28T12:30:00Z') });
  assert.equal((await at(leap, controller().signal)).disposition, 'expired');
});

test('response size is bounded at 64 KiB with absent or dishonest content length', async () => {
  const acknowledgement = JSON.stringify({ acknowledgements: [{ event_id: 'one', disposition: 'accepted' }] });
  const exact = acknowledgement.padEnd(65536, ' ');
  assert.equal((await sender(async () => new Response(exact))(event, controller().signal)).disposition, 'accepted');
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(exact)); c.enqueue(new Uint8Array([32])); c.enqueue(new Uint8Array([32])); c.close(); }, cancel() { cancelled = true; } });
    await assert.rejects(sender(async () => new Response(body, { headers }))(event, controller().signal), /collector response/);
    assert.ok(cancelled);
  }
  for (const length of ['65537', '9999999999999999999999999', '-1', 'invalid']) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(sender(async () => new Response(body, { headers: { 'content-length': length } }))(event, controller().signal), /collector response/);
    assert.ok(cancelled);
  }
});

test('chunked multibyte JSON is decoded without resetting the byte limit', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ acknowledgements: [{ event_id: 'one', disposition: 'accepted' }], ignored: '한글' }));
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.equal((await sender(async () => new Response(body))(event, controller().signal)).disposition, 'accepted');
});

test('invalid JSON, UTF-8 and response-stream errors expose no response content', async () => {
  for (const value of [token, '', '{"acknowledgements":', new Uint8Array([255])]) {
    await assert.rejects(sender(async () => new Response(value))(event, controller().signal), error => /collector response/.test(error.message) && !error.message.includes(token));
  }
  const body = new ReadableStream({ start(c) { c.error(new Error(token)); } });
  await assert.rejects(sender(async () => new Response(body))(event, controller().signal), error => !String(error).includes(token));
});

test('cancellation interrupts a stalled response stream', async () => {
  let cancelled = false; const abort = controller();
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const send = sender(async () => new Response(body));
  const pending = send(event, abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, /collector response/); assert.ok(cancelled);
});

test('input mutation during fetch cannot change the acknowledgement identity', async () => {
  const input = structuredClone(event);
  const send = sender(async () => { input.event_id = 'changed'; return response(); });
  assert.deepEqual(await send(input, controller().signal), { event_id: 'one', disposition: 'accepted' });
});
