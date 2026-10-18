import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { eventJSON, expiresAt, actorID, expiryMilliseconds, eventID } from '../dist/index.js';
const event = (id) => ({ schema_version: 1, event_id: id, operation_id: id,
  service: 'example', environment: 'test', occurred_at: '2026-10-18T00:00:00Z',
  actor: { id: 'maintenance', type: 'job' }, action: 'maintenance.edit',
  target_type: 'maintenance', target_id: 'example', result: 'ok', changes: [{ field: 'enabled', after: 'true' }] });
test('calendar expiry clamps leap day and preserves offset conversion and nanoseconds', () => {
  assert.equal(expiresAt('2024-02-29T12:34:56Z'), '2026-02-28T12:34:56Z');
  assert.equal(expiresAt('2026-01-01T01:00:00+09:00'), '2027-12-31T16:00:00Z');
  assert.equal(expiresAt('2024-02-29T12:34:56.123456789Z'), '2026-02-28T12:34:56.123456789Z');
});

test('typed envelope rejects unapproved fields, invalid principals and oversized content', () => {
  const audit = event('validation');
  assert.throws(() => eventJSON({ ...audit, raw_request: 'private' }), /Unsupported/);
  assert.throws(() => eventJSON({ ...audit, actor: { id: 'user', type: 'user' } }), /actor/);
  assert.throws(() => eventJSON({ ...audit, changes: [{ field: 'safe', after: 'x'.repeat(65536) }] }), /64 KiB/);
});

test('actor identities distinguish issuer/subject boundaries and key rotation', async () => {
  const key = new Uint8Array(32).fill(7);
  const a = await actorID(key, 'ab', 'c');
  assert.equal(await actorID(key, 'ab', 'c'), a);
  assert.notEqual(await actorID(key, 'a', 'bc'), a);
  assert.notEqual(await actorID(new Uint8Array(32).fill(8), 'ab', 'c'), a);
  await assert.rejects(actorID(new Uint8Array(4), 'ab', 'c'), /dedicated key/);
});

test('invalid calendar dates cannot normalize into a different audit occurrence', () => {
  assert.throws(() => eventJSON({ ...event('date'), occurred_at: '2026-02-30T12:00:00Z' }), /occurrence/);
  assert.throws(() => eventJSON({ ...event('date'), occurred_at: '2026-10-15T24:00:00Z' }), /occurrence/);
});

test('TypeScript follows the same retention and principal fixtures as audit-go', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures.retention) assert.equal(expiresAt(fixture.occurrence), fixture.expiry);
  for (const fixture of fixtures.principals) {
    assert.equal(await actorID(Uint8Array.from(Buffer.from(fixture.key_hex, 'hex')), fixture.issuer, fixture.subject), fixture.actor_id);
  }
});

test('serialized-size fixtures agree with the Go collector validator', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures.sizes) {
    const audit = { ...event('boundary'), changes: [{ field: 'name', after: fixture.character.repeat(fixture.repeat) }] };
    if (fixture.accepted) assert.doesNotThrow(() => eventJSON(audit));
    else assert.throws(() => eventJSON(audit), /64 KiB/);
  }
});

test('sub-millisecond expiry is never rounded into premature deletion', () => {
  assert.equal(expiryMilliseconds('2024-02-29T12:34:56.123000001Z'), Date.parse('2026-02-28T12:34:56.124Z'));
  assert.equal(expiryMilliseconds('2024-02-29T12:34:56.123000000Z'), Date.parse('2026-02-28T12:34:56.123Z'));
});
test('envelope rejects unpaired surrogates and PostgreSQL-incompatible NUL values', () => {
  for (const value of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00), String.fromCharCode(0)]) {
    assert.throws(() => eventJSON({ ...event('invalid'), target_id: value }));
    assert.throws(() => eventJSON({ ...event('invalid'), changes: [{ field: 'name', after: value }] }));
  }
});
test('identities contain 128 bits represented as lowercase hex', () => {
  assert.match(eventID(), /^[0-9a-f]{32}$/);
});

test('actor hashing accepts a caller view backed by shared memory', async () => {
  const key = new Uint8Array(new SharedArrayBuffer(32));
  key.fill(7);
  assert.equal(await actorID(key, 'ab', 'c'), '7d788c9ff14cffe959c2b5e23455907a1b8a10701befe2e5741360c1e2b68d04');
});

test('serialized event fields must be own enumerable data properties', () => {
  const valid = event('own');
  assert.throws(() => eventJSON(Object.create(valid)));
  assert.throws(() => eventJSON({ ...valid, actor: Object.create(valid.actor) }));
  assert.throws(() => eventJSON({ ...valid, changes: [Object.create({ field: 'enabled', after: 'true' })] }));
  const hidden = { ...valid };
  Object.defineProperty(hidden, 'action', { value: 'hidden', enumerable: false });
  assert.throws(() => eventJSON(hidden));
  const accessor = { ...valid, get action() { return 'changing'; } };
  assert.throws(() => eventJSON(accessor));
});

test('retention helpers reject invalid and non-RFC3339 occurrences', () => {
  for (const invalid of ['2026-02-30T12:00:00Z', '2026-10-18', '2026-10-18T24:00:00Z']) {
    assert.throws(() => expiresAt(invalid), /occurrence/);
    assert.throws(() => expiryMilliseconds(invalid), /occurrence/);
  }
});
