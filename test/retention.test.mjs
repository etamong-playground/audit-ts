import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { RelationalAuditStore, AuditConflict, AuditOutcomeUnknown } from '../dist/relational.js';

const keys = { activeID: 'v1', keys: { v1: new Uint8Array(32).fill(7) } };
const setup = async t => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch(){return new Response("ok")} }',
    compatibilityDate: '2026-07-22', d1Databases: { DB: 'retention-test' } });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB');
  await db.exec((await readFile(new URL('../relational-schema.sql', import.meta.url), 'utf8')).replaceAll('\n', ' '));
  let clock = Date.parse('2024-02-29T12:30:00Z'); const now = () => clock;
  const store = new RelationalAuditStore(db, keys, now);
  const event = (id, extra = {}) => ({ schema_version: 1, event_id: id, operation_id: id, service: 'test', environment: 'test',
    occurred_at: new Date(clock).toISOString(), actor: { type: 'job', id: 'cron' }, action: 'incident.open',
    target_type: 'incident', target_id: id, result: 'ok', ...extra });
  const add = async (id, extra) => { const value = event(id, extra); await store.commit([], value); return value; };
  const cleanup = id => event(id, { action: 'audit.cleanup', target_type: 'audit_history', target_id: 'test' });
  return { db, store, now, event, cleanup, add, setTime: value => { clock = Date.parse(value); } };
};
const rows = db => db.prepare('SELECT json_group_array(event_id) AS ids FROM (SELECT event_id FROM audit_events ORDER BY event_id)').first('ids').then(JSON.parse);

test('cleanup atomically retains only counts and ranges while removing expired pending delivery', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t);
  await add('old-private-target', { target_id: 'private-target', reason_code: 'private-reason' });
  await add('old-acknowledged', { occurred_at: '2024-02-27T12:30:00Z' });
  await db.prepare('DELETE FROM audit_delivery WHERE event_id=?').bind('old-acknowledged').run();
  setTime('2026-02-28T12:30:00Z'); await add('live');
  const result = await store.purgeExpired(cleanup('cleanup'));
  assert.deepEqual(result.changes, [
    { field: 'removed_count', after: '2' },
    { field: 'occurred_from', after: '2024-02-27T12:30:00.000Z' },
    { field: 'occurred_to', after: '2024-02-29T12:30:00.000Z' },
    { field: 'expired_from', after: '2026-02-27T12:30:00.000Z' },
    { field: 'expired_to', after: '2026-02-28T12:30:00.000Z' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-target|private-reason|old-acknowledged/);
  assert.deepEqual(await rows(db), ['cleanup', 'live']);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM audit_delivery').first('n'), 2);
  assert.deepEqual(JSON.parse(await db.prepare('SELECT payload FROM audit_events WHERE event_id=?').bind('cleanup').first('payload')), result);
});

test('expiry respects leap days and rounds fractional milliseconds upward', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t);
  await add('fraction', { occurred_at: '2024-02-29T12:30:00.000001Z' });
  setTime('2026-02-28T12:30:00Z');
  assert.equal(await store.purgeExpired(cleanup('early')), null);
  assert.deepEqual(await rows(db), ['fraction']);
  setTime('2026-02-28T12:30:00.001Z');
  assert.equal((await store.purgeExpired(cleanup('due'))).changes[0].after, '1');
  assert.deepEqual(await rows(db), ['due']);
});

test('limit and namespace selection preserve unrelated and unexpired history', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t);
  await add('a-old'); await add('b-old'); await add('other-service', { service: 'other' });
  await add('other-environment', { environment: 'other' });
  setTime('2026-02-28T12:30:00Z'); await add('live');
  assert.equal((await store.purgeExpired(cleanup('first'), 1)).changes[0].after, '1');
  assert.deepEqual(await rows(db), ['b-old', 'first', 'live', 'other-environment', 'other-service']);
  assert.equal((await store.purgeExpired(cleanup('second'), 1)).changes[0].after, '1');
  assert.equal(await store.purgeExpired(cleanup('empty')), null);
  assert.deepEqual(await rows(db), ['first', 'live', 'other-environment', 'other-service', 'second']);
});

test('invalid cleanup envelopes and limits cannot delete history', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t); await add('old');
  setTime('2026-02-28T12:30:00Z');
  for (const limit of [0, -1, 1001, 1.5, NaN]) await assert.rejects(store.purgeExpired(cleanup('bad'), limit));
  for (const extra of [{ action: 'incident.open' }, { actor: { type: 'service', id: 'caller' } }, { result: 'error' },
    { changes: [{ field: 'forged', after: '100' }] }, { occurred_at: '2020-01-01T00:00:00Z' }, { occurred_at: '2030-01-01T00:00:00Z' }]) {
    await assert.rejects(store.purgeExpired({ ...cleanup('bad'), ...extra }));
  }
  assert.deepEqual(await rows(db), ['old']);
});

test('cleanup outbox failure rolls back deletion and its evidence', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t); await add('old');
  setTime('2026-02-28T12:30:00Z');
  await db.exec("CREATE TRIGGER reject_cleanup BEFORE INSERT ON audit_delivery WHEN NEW.event_id='cleanup' BEGIN SELECT RAISE(ABORT,'outbox down'); END;");
  await assert.rejects(store.purgeExpired(cleanup('cleanup')), AuditOutcomeUnknown);
  assert.deepEqual(await rows(db), ['old']);
  assert.equal(await db.prepare('SELECT event_id FROM audit_delivery').first('event_id'), 'old');
});

test('concurrent cleaners cannot record a summary for rows already removed', async t => {
  const { db, add, cleanup, setTime, now } = await setup(t); await add('old'); setTime('2026-02-28T12:30:00Z');
  let waiting = 0; let release; const ready = new Promise(resolve => { release = resolve; });
  const wrapped = { withSession() {
    const session = db.withSession('first-primary');
    return { prepare(sql) {
      const statement = session.prepare(sql);
      if (!sql.startsWith('SELECT json_group_array')) return statement;
      return { bind(...values) { return { async first() {
        const result = await statement.bind(...values).first(); if (++waiting === 2) release(); await ready; return result;
      } }; } };
    }, batch: statements => session.batch(statements) };
  } };
  const store = new RelationalAuditStore(wrapped, keys, now);
  const results = await Promise.allSettled([store.purgeExpired(cleanup('first')), store.purgeExpired(cleanup('second'))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.ok(results.find(value => value.status === 'rejected').reason instanceof AuditOutcomeUnknown);
  assert.equal((await rows(db)).length, 1);
  const retained = JSON.parse(await db.prepare('SELECT payload FROM audit_events').first('payload'));
  assert.equal(retained.changes[0].after, '1');
});

test('lost batch response is confirmed while unavailable confirmation reports the cleanup identity', async t => {
  for (const confirmationFails of [false, true]) {
    const { db, add, cleanup, setTime, now } = await setup(t); await add('old'); setTime('2026-02-28T12:30:00Z');
    let batches = 0;
    const wrapped = { withSession() {
      if (batches && confirmationFails) throw Error('confirmation unavailable');
      const session = db.withSession('first-primary');
      return { prepare: sql => session.prepare(sql), batch: async statements => { await session.batch(statements); batches++; throw Error('ack lost'); } };
    } };
    const promise = new RelationalAuditStore(wrapped, keys, now).purgeExpired(cleanup('cleanup'));
    if (confirmationFails) await assert.rejects(promise, error => error instanceof AuditOutcomeUnknown && error.eventID === 'cleanup');
    else assert.equal((await promise).changes[0].after, '1');
    assert.deepEqual(await rows(db), ['cleanup']);
  }
});

test('a reused retained cleanup identity does not consume a later expired batch', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t); await add('a-old'); await add('b-old');
  setTime('2026-02-28T12:30:00Z'); const request = cleanup('cleanup');
  await store.purgeExpired(request, 1);
  await assert.rejects(store.purgeExpired(request, 1), AuditConflict);
  assert.deepEqual(await rows(db), ['b-old', 'cleanup']);
});


test('the maximum cleanup batch leaves overflow for another invocation', async t => {
  const { db, store, add, cleanup, setTime } = await setup(t);
  await add('template');
  await db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<1001)
    INSERT INTO audit_events(event_id,payload,fingerprint,key_id,occurred_at,expires_at)
    SELECT 'expired-'||n,json_set(payload,'$.event_id','expired-'||n,'$.operation_id','expired-'||n),
      fingerprint,key_id,occurred_at,expires_at FROM sequence,audit_events WHERE event_id='template'`).run();
  await db.prepare("DELETE FROM audit_events WHERE event_id='template'").run();
  setTime('2026-02-28T12:30:00Z');
  const result = await store.purgeExpired(cleanup('maximum'), 1000);
  assert.equal(result.changes[0].after, '1000');
  assert.equal((await rows(db)).length, 2);
  assert.equal((await store.purgeExpired(cleanup('overflow'))).changes[0].after, '1');
  assert.deepEqual(await rows(db), ['maximum', 'overflow']);
});
