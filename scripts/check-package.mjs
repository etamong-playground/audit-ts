import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('.tmp', { recursive: true });
const directory = await mkdtemp(resolve('.tmp/package-check-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { encoding: 'utf8' }));
  assert.equal(packed.name, '@etamong-playground/audit-ts');
  const destination = resolve(directory, 'node_modules/@etamong-playground/audit-ts');
  await mkdir(destination, { recursive: true });
  execFileSync('tar', ['-xzf', resolve(directory, packed.filename), '--strip-components=1', '-C', destination]);
  await writeFile(resolve(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectorSender } from '@etamong-playground/audit-ts/collector';
assert.equal(typeof collectorSender('https://collector.example/v1/events', 'a'.repeat(32)), 'function');
import { RelationalAuditExporter } from '@etamong-playground/audit-ts/delivery';
assert.equal(typeof RelationalAuditExporter, 'function');
import { expiresAt, eventID } from '@etamong-playground/audit-ts';
import { RelationalAuditStore, AuditConflict, AuditOutcomeUnknown } from '@etamong-playground/audit-ts/relational';
assert.equal(expiresAt('2024-02-29T12:30:00Z'), '2026-02-28T12:30:00Z');
assert.ok(eventID().length > 0);
assert.equal(typeof RelationalAuditStore, 'function');
assert.equal(typeof RelationalAuditStore.prototype.purgeExpired, 'function');
assert.ok(new AuditConflict() instanceof Error);
assert.ok(new AuditOutcomeUnknown('test', new Error('lost')) instanceof Error);
const schema = await readFile(new URL(import.meta.resolve('@etamong-playground/audit-ts/relational-schema.sql')), 'utf8');
assert.ok(schema.includes('CREATE TABLE'));
`);
  execFileSync(process.execPath, [resolve(directory, 'consumer.mjs')], { stdio: 'inherit' });
  console.log('Packed package exports resolve in an isolated consumer');
} finally {
  await rm(directory, { recursive: true, force: true });
}
