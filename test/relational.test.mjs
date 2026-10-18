import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { RelationalAuditStore, AuditConflict, AuditOutcomeUnknown } from '../dist/relational.js';

const replayKeys = { activeID: 'v1', keys: { v1: new Uint8Array(32).fill(7) } };
const event = (id) => ({ schema_version: 1, event_id: id, operation_id: id,
  service: 'probe-monitor', environment: 'test', occurred_at: new Date().toISOString(),
  actor: { id: 'cron', type: 'job' }, action: 'incident.open', target_type: 'incident', target_id: '1', result: 'ok' });
const insert = (id) => ({ sql: 'INSERT INTO incidents(id,state) VALUES(?,?)', params: [id,'open'], expectedChanges: 1 });
const setup = async (t) => {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }',
    compatibilityDate: '2026-07-22', d1Databases: { DB: 'relational-audit-test' } });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB');
  await db.exec((await readFile(new URL('../relational-schema.sql', import.meta.url), 'utf8')).replaceAll('\n',' '));
  await db.exec('CREATE TABLE incidents(id INTEGER PRIMARY KEY,state TEXT NOT NULL)');
  return { db, store: new RelationalAuditStore(db,replayKeys) };
};
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n');

test('native business rows, immutable events and outbox commit together', async (t) => {
  const {db,store} = await setup(t);
  await store.commit([insert(1)], event('atomic'));
  for (const table of ['incidents','audit_events','audit_delivery']) assert.equal(await count(db,table),1);
  assert.equal(await count(db,'audit_mutation_guard'),0);
  await assert.rejects(db.prepare("UPDATE audit_events SET payload='{}'").run(),/immutable/);
});

test('outbox failure rolls back multiple business writes and event', async (t) => {
  const {db,store} = await setup(t);
  await db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON audit_delivery BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
  await assert.rejects(store.commit([insert(1),insert(2)],event('outage')));
  for (const table of ['incidents','audit_events','audit_delivery','audit_mutation_guard']) assert.equal(await count(db,table),0);
});

test('a stale mutation guard rolls back earlier writes without successful history', async (t) => {
  const {db,store} = await setup(t);
  await assert.rejects(store.commit([insert(1), {sql: "UPDATE incidents SET state='closed' WHERE id=999", params: [], expectedChanges: 1}],event('stale')),AuditOutcomeUnknown);
  for (const table of ['incidents','audit_events','audit_delivery']) assert.equal(await count(db,table),0);
});

test('same retained request replays once and changed mutation input conflicts', async (t) => {
  const {db,store} = await setup(t); const audit = event('replay');
  await store.commit([insert(1)],audit);
  await store.commit([insert(1)],audit);
  await assert.rejects(store.commit([insert(2)],audit),AuditConflict);
  assert.equal(await count(db,'incidents'),1);
  assert.equal(await count(db,'audit_events'),1);
});

test('concurrent identical requests converge on one immutable commit', async (t) => {
  const {db,store} = await setup(t); const audit = event('race');
  await Promise.all([store.commit([insert(1)],audit),store.commit([insert(1)],audit)]);
  assert.equal(await count(db,'incidents'),1);
  assert.equal(await count(db,'audit_events'),1);
});

test('lost batch acknowledgement is confirmed against the primary', async (t) => {
  const {db} = await setup(t); let calls=0;
  const wrapped = { withSession(constraint) {
    assert.equal(constraint,'first-primary'); const session = db.withSession(constraint); calls++;
    return { prepare: sql => session.prepare(sql), batch: async statements => { await session.batch(statements); throw Error('lost response'); } };
  } };
  await new RelationalAuditStore(wrapped,replayKeys).commit([insert(1)],event('lost'));
  assert.equal(calls,2); assert.equal(await count(db,'incidents'),1);
});

test('failed confirmation retains an unknown outcome', async (t) => {
  const {db} = await setup(t); let calls=0;
  const wrapped = { withSession() {
    if (++calls===2) throw Error('primary unavailable');
    const session = db.withSession('first-primary');
    return { prepare: sql => session.prepare(sql), batch: async statements => { await session.batch(statements); throw Error('lost response'); } };
  } };
  await assert.rejects(new RelationalAuditStore(wrapped,replayKeys).commit([insert(1)],event('unknown')),AuditOutcomeUnknown);
  assert.equal(await count(db,'incidents'),1);
});

test('expired and implausibly future events never mutate domain rows', async (t) => {
  const {db,store} = await setup(t);
  for (const offset of [-3*366*86400000,3600000]) {
    await assert.rejects(store.commit([insert(1)],{...event('time'),occurred_at:new Date(Date.now()+offset).toISOString()}),/retention/);
  }
  assert.equal(await count(db,'incidents'),0);
});

test('replay key rotation preserves exact retained requests', async (t) => {
  const {db,store} = await setup(t); const audit = event('rotation');
  await store.commit([insert(1)],audit);
  const rotated = new RelationalAuditStore(db, {activeID: 'v2', keys: {...replayKeys.keys,v2:new Uint8Array(32).fill(9)}});
  await rotated.commit([insert(1)],audit);
  assert.equal(await count(db,'incidents'),1);
  await assert.rejects(new RelationalAuditStore(db,{activeID:'v2',keys:{v2:new Uint8Array(32).fill(9)}}).commit([insert(1)],audit),/Retained replay key/);
});

test('fingerprints require the secret replay key', async (t) => {
  const {db,store} = await setup(t); const audit = event('privacy');
  await store.commit([insert(1)],audit);
  const row = await db.prepare('SELECT payload,fingerprint,key_id FROM audit_events').first();
  const request = JSON.stringify([row.payload,[insert(1)]]);
  const guess = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request))),b=>b.toString(16).padStart(2,'0')).join('');
  assert.notEqual(row.fingerprint,guess);
  const wrongKey = new RelationalAuditStore(db,{activeID:'v1',keys:{v1:new Uint8Array(32).fill(8)}});
  await assert.rejects(wrongKey.commit([insert(1)],audit),AuditConflict);
});

test('domain constraint errors are not classified as mutation guard conflicts', async (t) => {
  const {db,store} = await setup(t);
  await db.exec('CREATE TABLE domain_rule(valid INTEGER CHECK(valid = 1))');
  await assert.rejects(store.commit([{sql:'INSERT INTO domain_rule(valid) VALUES(0)',params:[],expectedChanges:1}],event('constraint')), error => error instanceof AuditOutcomeUnknown && !(error instanceof AuditConflict));
  assert.equal(await count(db,'audit_events'),0);
});

test('a domain constraint using the guard name cannot change outcome classification', async (t) => {
  const {db,store} = await setup(t);
  await db.exec('CREATE TABLE domain_collision(valid INTEGER CONSTRAINT audit_mutation_rows_match CHECK(valid = 1))');
  await assert.rejects(store.commit([{sql:'INSERT INTO domain_collision VALUES(0)',params:[],expectedChanges:1}],event('named-constraint')),AuditOutcomeUnknown);
  assert.equal(await count(db,'audit_events'),0);
});

test('audit-only access events enqueue once without changing business rows', async (t) => {
  const {db,store} = await setup(t);
  const audit = {...event('access'),action:'incident.inspect'};
  await store.commit([],audit);
  await store.commit([],audit);
  assert.equal(await count(db,'incidents'),0);
  assert.equal(await count(db,'audit_events'),1);
  assert.equal(await count(db,'audit_delivery'),1);
  assert.equal(JSON.parse(await db.prepare('SELECT payload FROM audit_events').first('payload')).action,'incident.inspect');
});

test('competing requests with one identity commit only the winning business mutation', async (t) => {
  const {db,store} = await setup(t);
  const audit = event('competing');
  const results = await Promise.allSettled([store.commit([insert(1)],audit),store.commit([insert(2)],audit)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  const loser = results.find(result => result.status === 'rejected');
  assert.ok(loser.reason instanceof AuditConflict);
  const winnerID = results[0].status === 'fulfilled' ? 1 : 2;
  assert.equal(await db.prepare('SELECT id FROM incidents').first('id'),winnerID);
  assert.equal(await count(db,'incidents'),1);
  assert.equal(await count(db,'audit_events'),1);
  assert.equal(await count(db,'audit_delivery'),1);
});

test('batch and byte limits reject oversized requests without partial writes', async (t) => {
  const {db,store} = await setup(t);
  await assert.rejects(store.commit(Array.from({length:21},(_,index)=>insert(index+1)),event('too-many')),/20 mutations/);
  await assert.rejects(store.commit([{...insert(1),params:[1,'x'.repeat(1024*1024)]}],event('too-large')),/1 MiB/);
  for (const table of ['incidents','audit_events','audit_delivery']) assert.equal(await count(db,table),0);
  await store.commit(Array.from({length:20},(_,index)=>insert(index+1)),event('maximum'));
  assert.equal(await count(db,'incidents'),20);
  assert.equal(await count(db,'audit_events'),1);
  assert.equal(await count(db,'audit_delivery'),1);
});
