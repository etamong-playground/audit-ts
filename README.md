# TypeScript audit contracts

The package validates the fleet audit envelope and derives calendar-year retention and pseudonymous actor identities.
Only allowlisted semantic summaries belong in events; never include credentials, request bodies or prompt content.

```ts
import { eventID, eventJSON, expiresAt } from '@etamong-playground/audit-ts';

const id = eventID();
const event = {
  schema_version: 1 as const,
  event_id: id,
  operation_id: id,
  service: 'example',
  environment: 'development',
  occurred_at: new Date().toISOString(),
  actor: { id: 'catalog-maintenance', type: 'job' as const },
  action: 'model.enable',
  target_type: 'model',
  target_id: 'model-42',
  result: 'ok' as const,
  changes: [{ field: 'enabled', before: 'false', after: 'true' }],
};
const payload = eventJSON(event);
const expiry = expiresAt(event.occurred_at);
```

Envelope validation alone does not persist an event or guarantee mutation atomicity.
The producer must commit the event and outbox alongside the business mutation in its database transaction.
User actors require a verified issuer/subject, a dedicated audit HMAC key of at least 32 bytes, and the key version.
Two calendar years start at the original occurrence; replay never extends the deadline.
`expiryMilliseconds` rounds sub-millisecond expiry upward so millisecond-based storage never deletes early.

Event, actor and change records require own enumerable data properties; inherited fields, accessors and hidden fields are rejected rather than omitted during serialization.
All public retention helpers reject invalid calendar dates and non-RFC3339 occurrence strings.
Callers supply ordinary data records in a trusted JavaScript runtime.

## Relational D1 transactions

Install `relational-schema.sql` in the same D1 database as the application's domain tables before enabling writers.
Use a single trusted business DML statement per mutation, with bound scalar parameters and an exact positive expected affected-row count.
Statements must not control transactions, modify audit tables/schema, or invoke external effects; the adapter does not parse SQL into a security boundary.
Use predicates that exclude unchanged rows when a no-op must remain quiet.
An unmatched predicate rejects the batch and leaves no successful event.
An empty mutation list records an access or outcome event without a domain write.

```ts
import { RelationalAuditStore } from '@etamong-playground/audit-ts/relational';

const store = new RelationalAuditStore(env.DB, { activeID: 'v1', keys: { v1: replayKey } });
await store.commit([{
  sql: 'UPDATE incidents SET state=? WHERE id=? AND state=?',
  params: ['resolved', 42, 'open'],
  expectedChanges: 1,
}], event);
```

Each domain statement is immediately followed by an affected-row assertion inside the same D1 batch.
The event insert enqueues delivery through a database trigger; any guard, event or outbox failure rolls back the batch.
The adapter accepts at most 20 mutation statements and a 1 MiB serialized request, including the event and mutation parameters.
The caller owns semantic field allowlists and complete, bounded target attribution for bulk writes.
The schema prevents event UPDATE; the trusted D1 binding owner still controls database permissions, retention deletes and schema maintenance.

Exact retained replay compares a domain-separated HMAC fingerprint, including SQL, parameters and expected row counts.
Supply a dedicated replay key of at least 32 bytes and its version; retain prior key versions for the full event retention window so retries survive rotation.
Key values stay outside the database; each receipt stores only its key version and fingerprint.
A reused identity with changed content raises `AuditConflict`.
After a failed batch acknowledgement, a new primary session confirms the same fingerprint before returning success; absent or unavailable confirmation leaves `AuditOutcomeUnknown`, including rejected SQL batches.
The adapter preserves the underlying error as the cause and does not infer a retry disposition from SQLite error-message text.
Keep the original event and mutation request when investigating or retrying an unknown outcome.
Expired or more-than-five-minute future events are rejected before dispatch, and retries preserve the original occurrence and expiry.
Outbox scheduling, expiry cleanup and recovery replay are separate required integrations before production adoption.

## Relational outbox delivery

```ts
import { RelationalAuditExporter } from '@etamong-playground/audit-ts/delivery';

const exporter = new RelationalAuditExporter(env.DB);
const result = await exporter.exportOne(async (event, signal) => {
  return collector.send(event, signal);
});
if (result.status === 'retry') reportDeliveryFailure(result.eventID, result.error);
```

`exportOne` atomically leases at most one due, unexpired event for 30 seconds and gives the sender at most 10 seconds within the remaining lease.
The sender must propagate the abort signal to its network operation and return only a durable collector acknowledgement with the matching `event_id` and `accepted` or `expired` disposition.
The exporter rejects an `expired` acknowledgement before the original calendar deadline.
An event may expire while a request is in flight; the collector applies original expiry at ingestion, so an acknowledgement does not extend retention.
Use authenticated HTTPS without redirects and bound response bytes in the application transport; this module makes no HTTP requests itself.

A sender that ignores cancellation can still have a late external effect, but cannot acknowledge or release a replacement worker's lease.
The collector must deduplicate stable event IDs and reject changed-content replay; delivery is at least once, never an exactly-once network claim.
Lost acknowledgements retry the unchanged retained payload after restart, with persisted exponential backoff from one second to five minutes.
Validation failures also back off, allowing other due events to advance; callers must surface `retry` errors and `lease-lost` outcomes in monitoring.
Database failures reject the call, and an uncertain local acknowledgement remains safe to retry against the idempotent collector.
An `accepted` result removes only delivery bookkeeping, preserving event history and replay fingerprints until retention cleanup.
Expired events are not dispatched; cleanup remains a separately audited integration.
Call `exportOne` from a bounded application worker budget, not an unbounded drain loop.

## Validation

Run `pnpm install --frozen-lockfile`, `pnpm test` and `pnpm check:package`.
The `test` CI job runs the real Miniflare transaction tests and imports the packed artifact from an isolated consumer directory.

## Release

Configure the npm Trusted Publisher for organization `etamong-playground`, repository `audit-ts`, workflow `publish.yml`, with direct publishing enabled before the first release.
A new npm package may require account-side bootstrap before its Trusted Publisher can be configured.

Merge a stable version bump, then dispatch `Publish` on `main`.
The workflow runs tests and packed consumer checks before cutting `v<package.json version>` and publishing the same tarball to public npm and the GitHub Packages mirror.
An existing version tag must identify the same commit; an existing registry version must have matching integrity.
Rerun the same workflow run after a partial publication failure, preserving its commit.
Never move a released tag or reuse a version with changed content; bump the version instead.
Publication is explicit, with no push-triggered release.
