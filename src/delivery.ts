import { eventJSON, expiryMilliseconds, type DurableEvent } from './event.js';
import type { Database } from './relational.js';

export type Acknowledgement = { event_id: string; disposition: 'accepted' | 'expired' };
export type Sender = (event: DurableEvent, signal: AbortSignal) => Promise<Acknowledgement>;
export type DeliveryResult = { status: 'empty' } |
  { status: 'accepted' | 'lease-lost'; eventID: string } |
  { status: 'retry'; eventID: string; error: unknown };
type Claim = { event_id: string; attempts: number };
type Retained = { payload: string; occurred_at: number; expires_at: number };

const leaseMilliseconds = 30000;
const sendMilliseconds = 10000;

export class RelationalAuditExporter {
  constructor(private readonly database: Database, private readonly now = Date.now) {}

  async exportOne(send: Sender): Promise<DeliveryResult> {
    const session = this.database.withSession('first-primary');
    const token = crypto.randomUUID();
    const started = this.now();
    const claim = await session.prepare(`UPDATE audit_delivery SET lease_token=?,lease_until=?,attempts=attempts+1
      WHERE event_id=(SELECT d.event_id FROM audit_delivery d JOIN audit_events e ON e.event_id=d.event_id
        WHERE d.available_at<=? AND COALESCE(d.lease_until,0)<=? AND e.expires_at>?
        ORDER BY d.available_at,d.event_id LIMIT 1)
      RETURNING event_id,attempts`).bind(token, started + leaseMilliseconds, started, started, started).first<Claim>();
    if (!claim) return { status: 'empty' };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const retained = await session.prepare('SELECT payload,occurred_at,expires_at FROM audit_events WHERE event_id=?')
        .bind(claim.event_id).first<Retained>();
      if (!retained) throw new Error('Retained audit event is unavailable');
      const event: DurableEvent = JSON.parse(retained.payload);
      eventJSON(event);
      if (event.event_id !== claim.event_id || Date.parse(event.occurred_at) !== retained.occurred_at ||
        expiryMilliseconds(event.occurred_at) !== retained.expires_at) throw new Error('Retained audit identity or expiry mismatch');
      if (retained.expires_at <= this.now()) throw new Error('Audit event expired before dispatch');
      const remaining = Math.min(sendMilliseconds, started + leaseMilliseconds - this.now());
      if (remaining <= 0) throw new Error('Audit delivery lease expired before dispatch');
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Audit sender deadline exceeded'));
        }, remaining);
      });
      const acknowledgement = await Promise.race([Promise.resolve().then(() => send(event, controller.signal)), deadline]);
      if (!acknowledgement || acknowledgement.event_id !== claim.event_id ||
        !['accepted', 'expired'].includes(acknowledgement.disposition)) throw new Error('Invalid audit acknowledgement');
      if (acknowledgement.disposition === 'expired' && retained.expires_at > this.now()) {
        throw new Error('Collector expired an unexpired audit event');
      }
      const removed = await session.prepare(`DELETE FROM audit_delivery
        WHERE event_id=? AND lease_token=? AND lease_until>? RETURNING event_id`)
        .bind(claim.event_id, token, this.now()).first<{ event_id: string }>();
      return { status: removed ? 'accepted' : 'lease-lost', eventID: claim.event_id };
    } catch (error) {
      const retryAt = this.now() + Math.min(300000, 1000 * 2 ** Math.min(claim.attempts - 1, 9));
      const released = await session.prepare(`UPDATE audit_delivery SET available_at=?,lease_token=NULL,lease_until=NULL
        WHERE event_id=? AND lease_token=? AND lease_until>? RETURNING event_id`)
        .bind(retryAt, claim.event_id, token, this.now()).first<{ event_id: string }>();
      return released ? { status: 'retry', eventID: claim.event_id, error } : { status: 'lease-lost', eventID: claim.event_id };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
