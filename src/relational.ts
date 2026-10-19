import { eventJSON, expiryMilliseconds, type DurableEvent } from './event.js';

export type SQLValue = string | number | null;
export type Mutation = { sql: string; params: SQLValue[]; expectedChanges: number };
export interface Statement {
  bind(...values: SQLValue[]): Statement;
  first<T>(): Promise<T | null>;
}
export interface Session {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}
export interface Database { withSession(constraint: 'first-primary'): Session }
export class AuditConflict extends Error {
  constructor() { super('Audit identity or mutation conflict'); }
}
export class AuditOutcomeUnknown extends Error {
  constructor(readonly eventID: string, cause: unknown) {
    super('Audit commit outcome could not be confirmed', { cause });
  }
}

export type ReplayKeys = { activeID: string; keys: Readonly<Record<string, Uint8Array>> };
type Receipt = { fingerprint: string; key_id: string };

export class RelationalAuditStore {
  private readonly keys = new Map<string, Uint8Array<ArrayBuffer>>();
  private readonly activeID: string;
  constructor(private readonly database: Database, replayKeys: ReplayKeys, private readonly now = Date.now) {
    for (const [id, key] of Object.entries(replayKeys.keys)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || !(key instanceof Uint8Array) || key.length < 32) {
        throw new Error('Replay fingerprints require versioned dedicated keys of at least 32 bytes');
      }
      this.keys.set(id, new Uint8Array(key));
    }
    this.activeID = replayKeys.activeID;
    if (!this.keys.has(this.activeID)) throw new Error('Active replay key is unavailable');
  }

  private async fingerprint(request: string, keyID: string): Promise<string> {
    const key = this.keys.get(keyID);
    if (!key) throw new Error('Retained replay key is unavailable');
    const signingKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hash = await crypto.subtle.sign('HMAC', signingKey,
      new TextEncoder().encode(JSON.stringify(['audit-ts/relational/v1', keyID, request])));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async purgeExpired(event: DurableEvent, limit = 1000): Promise<DurableEvent | null> {
    const base: DurableEvent = JSON.parse(eventJSON(event));
    if (base.action !== 'audit.cleanup' || base.actor.type !== 'job' || base.result !== 'ok' ||
      (base.changes?.length ?? 0) !== 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid audit cleanup');
    }
    const cutoff = this.now();
    if (Date.parse(base.occurred_at) > cutoff + 300000 || expiryMilliseconds(base.occurred_at) <= cutoff) {
      throw new Error('Audit occurrence is outside retention');
    }
    const session = this.database.withSession('first-primary');
    const prior = await session.prepare('SELECT event_id FROM audit_events WHERE event_id=?')
      .bind(base.event_id).first<{ event_id: string }>();
    if (prior) throw new AuditConflict();
    const snapshot = await session.prepare(`SELECT json_group_array(event_id) AS ids,count(*) AS removed,
      min(occurred_at) AS occurred_from,max(occurred_at) AS occurred_to,
      min(expires_at) AS expired_from,max(expires_at) AS expired_to FROM (
        SELECT event_id,occurred_at,expires_at FROM audit_events
        WHERE expires_at<=? AND json_extract(payload,'$.service')=? AND json_extract(payload,'$.environment')=?
        ORDER BY expires_at,event_id LIMIT ?)`)
      .bind(cutoff, base.service, base.environment, limit).first<{
        ids: string; removed: number; occurred_from: number; occurred_to: number; expired_from: number; expired_to: number;
      }>();
    if (!snapshot) throw new Error('Audit retention snapshot is unavailable');
    if (snapshot.removed === 0) return null;
    const summary: DurableEvent = { ...base, changes: [
      { field: 'removed_count', after: String(snapshot.removed) },
      { field: 'occurred_from', after: new Date(snapshot.occurred_from).toISOString() },
      { field: 'occurred_to', after: new Date(snapshot.occurred_to).toISOString() },
      { field: 'expired_from', after: new Date(snapshot.expired_from).toISOString() },
      { field: 'expired_to', after: new Date(snapshot.expired_to).toISOString() },
    ] };
    await this.commit([{
      sql: `DELETE FROM audit_events WHERE event_id IN (SELECT value FROM json_each(?)) AND expires_at<=?`,
      params: [snapshot.ids, cutoff], expectedChanges: snapshot.removed,
    }], summary);
    return summary;
  }

  async commit(input: Mutation[], event: DurableEvent): Promise<void> {
    const payload = eventJSON(event);
    const retained: DurableEvent = JSON.parse(payload);
    const mutations = input.map(({ sql, params, expectedChanges }) => ({ sql, params: [...params], expectedChanges }));
    if (mutations.length > 20) throw new Error('Audit batch exceeds 20 mutations');
    for (const mutation of mutations) {
      if (!mutation.sql.trim() || !Number.isSafeInteger(mutation.expectedChanges) || mutation.expectedChanges < 1 ||
        mutation.params.some((value) => value !== null && typeof value !== 'string' &&
          !(typeof value === 'number' && Number.isFinite(value)))) throw new Error('Invalid audit mutation');
    }
    const occurrence = Date.parse(retained.occurred_at);
    const expiry = expiryMilliseconds(retained.occurred_at);
    const now = this.now();
    if (occurrence > now + 300000 || expiry <= now) throw new Error('Audit occurrence is outside retention');
    const request = JSON.stringify([payload, mutations]);
    if (new TextEncoder().encode(request).length > 1024 * 1024) throw new Error('Audit mutation request exceeds 1 MiB');
    const fingerprint = await this.fingerprint(request, this.activeID);
    const lookup = (session: Session) => session.prepare('SELECT fingerprint,key_id FROM audit_events WHERE event_id=?')
      .bind(retained.event_id).first<Receipt>();
    const matches = async (receipt: Receipt) => receipt.fingerprint === await this.fingerprint(request, receipt.key_id);
    const session = this.database.withSession('first-primary');
    const prior = await lookup(session);
    if (prior) {
      if (!await matches(prior)) throw new AuditConflict();
      return;
    }
    const statements = [];
    for (const mutation of mutations) {
      statements.push(session.prepare(mutation.sql).bind(...mutation.params));
      statements.push(session.prepare(`INSERT INTO audit_mutation_guard(singleton,valid) VALUES(1,changes()=?)
        ON CONFLICT(singleton) DO UPDATE SET valid=excluded.valid`).bind(mutation.expectedChanges));
    }
    statements.push(session.prepare('DELETE FROM audit_mutation_guard'));
    statements.push(session.prepare(`INSERT INTO audit_events(event_id,payload,fingerprint,key_id,occurred_at,expires_at)
      VALUES(?,?,?,?,?,?)`).bind(retained.event_id, payload, fingerprint, this.activeID, occurrence, expiry));
    try { await session.batch(statements); }
    catch (cause) {
      let confirmed;
      try { confirmed = await lookup(this.database.withSession('first-primary')); }
      catch (confirmationFailure) {
        throw new AuditOutcomeUnknown(retained.event_id, new AggregateError([cause, confirmationFailure]));
      }
      try {
        if (confirmed && await matches(confirmed)) return;
      } catch (confirmationFailure) {
        throw new AuditOutcomeUnknown(retained.event_id, new AggregateError([cause, confirmationFailure]));
      }
      if (confirmed) throw new AuditConflict();
      throw new AuditOutcomeUnknown(retained.event_id, cause);
    }
  }
}
