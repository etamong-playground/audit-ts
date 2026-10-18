import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const registry = process.argv[2];
if (!['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(registry)) {
  throw new Error('Unsupported release registry');
}
const [artifact] = JSON.parse(readFileSync('.tmp/release/pack.json', 'utf8'));
const spec = `${artifact.name}@${artifact.version}`;
const view = spawnSync('npm', ['view', spec, 'dist.integrity', '--json', '--registry', registry], { encoding: 'utf8' });
if (view.error) throw view.error;
if (view.status === 0) {
  if (JSON.parse(view.stdout) !== artifact.integrity) throw new Error(`${spec} already exists with different content`);
  console.log(`${spec} already published with matching integrity`);
} else {
  let failure;
  try { failure = JSON.parse(view.stdout); } catch { /* npm may fail before producing JSON. */ }
  if (failure?.error?.code !== 'E404') throw new Error(`Cannot inspect ${spec}: ${view.stderr}`);
  const publish = spawnSync('npm', ['publish', resolve('.tmp/release', artifact.filename), '--registry', registry,
    ...(registry === 'https://registry.npmjs.org' ? ['--access', 'public', '--provenance'] : [])], { stdio: 'inherit' });
  if (publish.error) throw publish.error;
  if (publish.status !== 0) throw new Error(`Publishing ${spec} failed`);
}
