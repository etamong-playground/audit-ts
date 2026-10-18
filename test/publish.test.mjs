import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/publish-package.mjs');
mkdirSync('.tmp', { recursive: true });
for (const [name, status, response, publishStatus, expectedCalls, succeeds] of [
  ['new version publishes', 1, { error: { code: 'E404' } }, 0, 2, true],
  ['matching version is a no-op', 0, 'sha512-release', 0, 1, true],
  ['different content is rejected', 0, 'sha512-other', 0, 1, false],
  ['authorization failure cannot publish', 1, { error: { code: 'E403' } }, 0, 1, false],
  ['network failure cannot publish', 1, { error: { code: 'ECONNRESET' } }, 0, 1, false],
  ['malformed response cannot publish', 1, null, 0, 1, false],
  ['failed publish fails the release', 1, { error: { code: 'E404' } }, 1, 2, false],
]) {
  for (const registry of ['https://registry.npmjs.org', 'https://npm.pkg.github.com']) {
    test(`${name}: ${registry}`, () => {
      const directory = mkdtempSync(resolve('.tmp/publish-test-'));
      try {
        mkdirSync(join(directory, '.tmp/release'), { recursive: true });
        writeFileSync(join(directory, '.tmp/release/pack.json'), JSON.stringify([{
          name: '@etamong-playground/audit-ts', version: '0.1.0',
          integrity: 'sha512-release', filename: 'release.tgz',
        }]));
        writeFileSync(join(directory, 'npm'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');
if (process.argv[2] === 'view') {
  process.stdout.write(${JSON.stringify(response === null ? 'not json' : JSON.stringify(response))});
  process.exit(${status});
}
process.exit(${publishStatus});
`, { mode: 0o755 });
        writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
        const result = spawnSync(process.execPath, [script, registry], {
          cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        });
        assert.equal(result.status === 0, succeeds, result.stderr);
        const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(calls.length, expectedCalls);
        assert.deepEqual(calls[0], ['view', '@etamong-playground/audit-ts@0.1.0', 'dist.integrity', '--json', '--registry', registry]);
        if (expectedCalls === 2) assert.deepEqual(calls[1], ['publish', join(directory, '.tmp/release/release.tgz'), '--registry', registry,
          ...(registry === 'https://registry.npmjs.org' ? ['--access', 'public', '--provenance'] : [])]);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
}
