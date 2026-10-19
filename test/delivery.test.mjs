import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { RelationalAuditStore } from '../dist/relational.js';
import { RelationalAuditExporter } from '../dist/delivery.js';

const setup = async (t) => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch(){return new Response("ok")} }',
    compatibilityDate: '2026-07-22', d1Databases: { DB: 'delivery-test' } });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB');
  await db.exec((await readFile(new URL('../relational-schema.sql', import.meta.url), 'utf8')).replaceAll('\n', ' '));
  let clock = Date.parse('2026-10-19T00:00:00Z');
  const now = () => clock;
  const store = new RelationalAuditStore(db, { activeID: 'v1', keys: { v1: new Uint8Array(32).fill(7) } }, now);
  const add = async (id, occurrence = new Date(clock).toISOString()) => {
    const event = { schema_version: 1, event_id: id, operation_id: id, service: 'test', environment: 'test',
      occurred_at: occurrence, actor: { type: 'job', id: 'cron' }, action: 'incident.open',
      target_type: 'incident', target_id: id, result: 'ok' };
    await store.commit([], event);
    return event;
  };
  return { db, add, now, advance: ms => { clock += ms; }, exporter: new RelationalAuditExporter(db, now) };
};
const accepted = async event => ({ event_id: event.event_id, disposition: 'accepted' });
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('accepted delivery removes bookkeeping while preserving original history and fingerprint', async t => {
  const { db, add, exporter } = await setup(t);
  const event = await add('accepted');
  const before = await db.prepare('SELECT * FROM audit_events').first();
  let sent;
  assert.deepEqual(await exporter.exportOne(async value => { sent = value; return accepted(value); }),
    { status: 'accepted', eventID: event.event_id });
  assert.deepEqual(sent, event);
  assert.equal(await count(db, 'audit_delivery'), 0);
  assert.deepEqual(await db.prepare('SELECT * FROM audit_events').first(), before);
  assert.deepEqual(await exporter.exportOne(() => { throw Error('unexpected send'); }), { status: 'empty' });
});

test('lost acknowledgement survives exporter restart and replays the same event after backoff', async t => {
  const { db, add, exporter, now, advance } = await setup(t);
  const event = await add('lost');
  const received = new Map();
  const send = async value => { received.set(value.event_id, value); throw Error('response lost after collector commit'); };
  assert.equal((await exporter.exportOne(send)).status, 'retry');
  const row = await db.prepare('SELECT * FROM audit_delivery').first();
  assert.equal(row.attempts, 1); assert.equal(row.available_at, now() + 1000); assert.equal(row.lease_token, null);
  const restarted = new RelationalAuditExporter(db, now);
  assert.deepEqual(await restarted.exportOne(accepted), { status: 'empty' });
  advance(1000);
  assert.equal((await restarted.exportOne(async value => { assert.deepEqual(value, received.get(value.event_id)); return accepted(value); })).status, 'accepted');
  assert.equal(received.size, 1); assert.deepEqual(received.get(event.event_id), event);
});

test('concurrent exporters cannot send an actively leased event twice', async t => {
  const { add, exporter } = await setup(t); await add('concurrent');
  const entered = deferred(); const release = deferred();
  const first = exporter.exportOne(async event => { entered.resolve(); await release.promise; return accepted(event); });
  await entered.promise;
  try { assert.deepEqual(await exporter.exportOne(() => { throw Error('duplicate'); }), { status: 'empty' }); }
  finally { release.resolve(); }
  assert.equal((await first).status, 'accepted');
});

test('expired lease cannot acknowledge or release a replacement claim', async t => {
  for (const fail of [false, true]) {
    const { db, add, exporter, advance } = await setup(t); await add('fenced');
    const entered = deferred(); const release = deferred();
    const old = exporter.exportOne(async event => { entered.resolve(); await release.promise; if (fail) throw Error('old failed'); return accepted(event); });
    await entered.promise; advance(30001);
    const nextEntered = deferred(); const nextRelease = deferred();
    const current = exporter.exportOne(async event => { nextEntered.resolve(); await nextRelease.promise; return accepted(event); });
    await nextEntered.promise;
    const claim = await db.prepare('SELECT * FROM audit_delivery').first();
    release.resolve(); assert.equal((await old).status, 'lease-lost');
    assert.deepEqual(await db.prepare('SELECT * FROM audit_delivery').first(), claim);
    nextRelease.resolve(); assert.equal((await current).status, 'accepted');
  }
});

test('invalid acknowledgements and premature expiry remain queued', async t => {
  const { db, add, exporter, advance } = await setup(t); await add('invalid');
  for (const ack of [undefined, { event_id: 'other', disposition: 'accepted' },
    { event_id: 'invalid', disposition: 'conflict' }, { event_id: 'invalid', disposition: 'expired' }]) {
    const result = await exporter.exportOne(async () => ack);
    assert.equal(result.status, 'retry'); assert.ok(result.error instanceof Error);
    assert.equal(await count(db, 'audit_delivery'), 1); advance(300000);
  }
});

test('expiry is preserved and only a genuinely expired in-flight acknowledgement is accepted', async t => {
  const { db, add, exporter, advance } = await setup(t);
  await add('expiring', '2024-10-19T00:00:00.001Z');
  assert.equal((await exporter.exportOne(async event => { advance(1); return { event_id: event.event_id, disposition: 'expired' }; })).status, 'accepted');
  assert.equal(await count(db, 'audit_events'), 1);
  await add('already-expired'); advance(3 * 366 * 86400000);
  assert.deepEqual(await exporter.exportOne(() => { throw Error('expired event dispatched'); }), { status: 'empty' });
  assert.equal(await count(db, 'audit_delivery'), 1);
});

test('corrupt retained event backs off without blocking a healthy successor', async t => {
  for (const change of ["payload='{}'", "payload=json_set(payload,'$.event_id','different')", 'expires_at=expires_at+1', 'occurred_at=occurred_at+1']) {
    const { db, add, exporter } = await setup(t); await add('a-bad'); await add('b-good');
    await db.exec('DROP TRIGGER audit_immutable');
    await db.exec(`UPDATE audit_events SET ${change} WHERE event_id='a-bad'`);
    let sent = 0;
    assert.equal((await exporter.exportOne(async event => { sent++; return accepted(event); })).status, 'retry');
    assert.equal(sent, 0);
    assert.deepEqual(await exporter.exportOne(accepted), { status: 'accepted', eventID: 'b-good' });
  }
});

test('retry backoff caps and abandoned claims recover without changing event identity', async t => {
  const { db, add, exporter, advance, now } = await setup(t); await add('crashed');
  await db.prepare('UPDATE audit_delivery SET attempts=1000,lease_token=?,lease_until=?').bind('dead', now() + 30000).run();
  assert.deepEqual(await exporter.exportOne(accepted), { status: 'empty' }); advance(30000);
  assert.equal((await exporter.exportOne(async () => { throw Error('offline'); })).status, 'retry');
  assert.equal(await db.prepare('SELECT available_at FROM audit_delivery').first('available_at'), now() + 300000);
  advance(300000); assert.equal((await exporter.exportOne(accepted)).status, 'accepted');
});

test('sender deadline aborts and returns even when the sender ignores cancellation', async t => {
  const { add, exporter } = await setup(t); await add('timeout');
  let signal;
  const started = Date.now();
  const result = await exporter.exportOne(async (_, value) => { signal = value; return new Promise(() => {}); });
  assert.equal(result.status, 'retry'); assert.match(result.error.message, /deadline/);
  assert.ok(signal.aborted); assert.ok(Date.now() - started < 15000);
});

test('database failure during acknowledgement remains replayable', async t => {
  const { db, add, now, advance } = await setup(t); await add('db-failure');
  const wrapped = { withSession() {
    const session = db.withSession('first-primary');
    return { prepare(sql) {
      if (sql.startsWith('DELETE FROM audit_delivery')) throw Error('database unavailable');
      return session.prepare(sql);
    }, batch: statements => session.batch(statements) };
  } };
  const result = await new RelationalAuditExporter(wrapped, now).exportOne(accepted);
  assert.equal(result.status, 'retry'); assert.equal(await count(db, 'audit_delivery'), 1);
  advance(1000); assert.equal((await new RelationalAuditExporter(db, now).exportOne(accepted)).status, 'accepted');
});
