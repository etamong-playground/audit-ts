import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { RelationalAuditStore, AuditConflict } from '../dist/relational.js';
import { RelationalAuditExporter } from '../dist/delivery.js';
import { collectorSender } from '../dist/collector.js';

const keys = { activeID: 'v1', keys: { v1: new Uint8Array(32).fill(7) } };
const token = 'test-producer-token-'.repeat(3);
const event = (id, occurrence) => ({ schema_version: 1, event_id: id, operation_id: id, service: 'restore-test',
  environment: 'test', occurred_at: occurrence, actor: { type: 'job', id: 'cron' }, action: 'incident.open',
  target_type: 'incident', target_id: id, result: 'ok' });
const mutation = { sql: 'INSERT INTO incidents(id,state) VALUES(?,?)', params: [1, 'open'], expectedChanges: 1 };
const tables = ['incidents', 'audit_events', 'audit_delivery'];

const database = async (t, id) => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch(){return new Response("ok")} }',
    compatibilityDate: '2026-07-22', d1Databases: { DB: id } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.dispose(); } };
  t.after(close);
  const db = await runtime.getD1Database('DB');
  await db.exec((await readFile(new URL('../relational-schema.sql', import.meta.url), 'utf8')).replaceAll('\n', ' '));
  await db.exec('CREATE TABLE incidents(id INTEGER PRIMARY KEY,state TEXT NOT NULL)');
  return { db, close };
};
const backupFile = async t => {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return resolve(directory, 'rows.json');
};
const backup = async (db, file) => {
  const rows = {};
  for (const table of tables) rows[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  await writeFile(file, JSON.stringify(rows));
};
const restore = async (db, file) => {
  const rows = JSON.parse(await readFile(file, 'utf8'));
  const inserts = table => rows[table].map(row => {
    const columns = Object.keys(row);
    return db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).bind(...Object.values(row));
  });
  await db.batch([...inserts('incidents'), ...inserts('audit_events'), db.prepare('DELETE FROM audit_delivery'), ...inserts('audit_delivery')]);
  return rows;
};
const collector = () => {
  const records = new Map(); const requests = [];
  const fetch = async (_, init) => {
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); assert.equal(body.events.length, 1);
    const received = body.events[0]; requests.push(received);
    const identity = `${received.service}/${received.event_id}`;
    const payload = JSON.stringify(received);
    if (records.has(identity) && records.get(identity) !== payload) return new Response('conflict detail must not leak', { status: 409 });
    records.set(identity, payload);
    return Response.json({ acknowledgements: [{ event_id: received.event_id, disposition: 'accepted' }] });
  };
  return { records, requests, fetch };
};

test('restored rows preserve identity, original expiry and key generations across lost acknowledgement', async t => {
  const file = await backupFile(t); const source = await database(t, 'recovery-source');
  let clock = Date.parse('2024-02-29T12:30:00Z'); const now = () => clock;
  const store = new RelationalAuditStore(source.db, keys, now);
  const expired = event('expired', '2024-02-29T12:30:00Z'); await store.commit([], expired);
  clock = Date.parse('2026-02-28T12:30:00Z');
  const live = event('live', '2026-02-28T12:30:00Z'); await store.commit([mutation], live);
  const remote = collector();
  const losingSender = collectorSender('https://collector.example/v1/events', token, { now, fetch: async (...args) => {
    await backup(source.db, file);
    await remote.fetch(...args);
    throw Error('response lost after durable collector acceptance');
  } });
  assert.equal((await new RelationalAuditExporter(source.db, now).exportOne(losingSender)).status, 'retry');
  assert.equal(remote.records.size, 1);
  await source.close();

  const target = await database(t, 'recovery-target');
  const snapshot = await restore(target.db, file);
  for (const table of tables) assert.deepEqual((await target.db.prepare(`SELECT * FROM ${table}`).all()).results, snapshot[table]);
  const liveBefore = snapshot.audit_events.find(row => row.event_id === 'live');
  assert.equal(liveBefore.expires_at, Date.parse('2028-02-28T12:30:00Z'));
  assert.equal(snapshot.audit_events.find(row => row.event_id === 'expired').expires_at, Date.parse('2026-02-28T12:30:00Z'));
  const send = collectorSender('https://collector.example/v1/events', token, { fetch: remote.fetch, now });
  const exporter = new RelationalAuditExporter(target.db, now);
  assert.deepEqual(await exporter.exportOne(send), { status: 'empty' });
  assert.equal(remote.requests.length, 1);

  const rotated = { activeID: 'v2', keys: { ...keys.keys, v2: new Uint8Array(32).fill(9) } };
  const recovered = new RelationalAuditStore(target.db, rotated, now);
  await recovered.commit([mutation], live);
  assert.deepEqual((await target.db.prepare('SELECT * FROM incidents').all()).results, [{ id: 1, state: 'open' }]);
  await assert.rejects(recovered.commit([{ ...mutation, params: [2, 'open'] }], live), AuditConflict);
  await assert.rejects(new RelationalAuditStore(target.db, { activeID: 'v2', keys: { v2: rotated.keys.v2 } }, now).commit([mutation], live), /Retained replay key/);
  await assert.rejects(recovered.commit([], expired), /retention/);
  assert.deepEqual(await target.db.prepare("SELECT event_id FROM audit_events WHERE expires_at>?").bind(clock).first(), { event_id: 'live' });

  clock += 30001;
  assert.deepEqual(await exporter.exportOne(send), { status: 'accepted', eventID: 'live' });
  assert.equal(remote.records.size, 1);
  assert.deepEqual(remote.requests, [live, live]);
  assert.deepEqual(await target.db.prepare("SELECT * FROM audit_events WHERE event_id='live'").first(), liveBefore);
  const cleanup = { ...event('cleanup', new Date(clock).toISOString()), action: 'audit.cleanup', target_type: 'audit_history', target_id: 'restore-test' };
  assert.equal((await recovered.purgeExpired(cleanup)).changes[0].after, '1');
  assert.equal(await target.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_id='expired'").first('n'), 0);
  assert.equal(await target.db.prepare("SELECT count(*) AS n FROM audit_delivery WHERE event_id='expired'").first('n'), 0);
  assert.deepEqual(await exporter.exportOne(send), { status: 'accepted', eventID: 'cleanup' });
  assert.equal(remote.records.size, 2);
  assert.deepEqual(remote.requests.map(value => value.event_id), ['live', 'live', 'cleanup']);
  assert.equal(await target.db.prepare("SELECT expires_at FROM audit_events WHERE event_id='live'").first('expires_at'), Date.parse('2028-02-28T12:30:00Z'));
});

test('restored replay conflicting with collector history remains queued without overwriting either record', async t => {
  const file = await backupFile(t); const source = await database(t, 'conflict-source');
  const now = () => Date.parse('2026-02-28T12:30:00Z');
  const live = event('conflict', '2026-02-28T12:30:00Z');
  await new RelationalAuditStore(source.db, keys, now).commit([mutation], live);
  await backup(source.db, file); await source.close();
  const target = await database(t, 'conflict-target'); await restore(target.db, file);
  const remote = collector(); const prior = JSON.stringify({ ...live, result: 'error' }); remote.records.set('restore-test/conflict', prior);
  const send = collectorSender('https://collector.example/v1/events', token, { fetch: remote.fetch, now });
  const result = await new RelationalAuditExporter(target.db, now).exportOne(send);
  assert.equal(result.status, 'retry'); assert.doesNotMatch(String(result.error), /conflict detail/);
  assert.equal(remote.records.get('restore-test/conflict'), prior);
  assert.deepEqual(JSON.parse(await target.db.prepare('SELECT payload FROM audit_events').first('payload')), live);
  assert.equal(await target.db.prepare('SELECT event_id FROM audit_delivery').first('event_id'), 'conflict');
});
