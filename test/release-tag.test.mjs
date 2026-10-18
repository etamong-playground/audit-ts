import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/cut-release-tag.sh');
mkdirSync('.tmp', { recursive: true });
test('release tags are immutable, stable and repeatable at the same commit', () => {
  const directory = mkdtempSync(resolve('.tmp/tag-test-'));
  const repository = join(directory, 'source');
  const remote = join(directory, 'remote.git');
  function git(...args) {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function cut() { return spawnSync('bash', [script], { cwd: repository, encoding: 'utf8' }); }
  try {
    mkdirSync(repository);
    git('init', '--bare', remote);
    git('init');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release@example.invalid');
    git('remote', 'add', 'origin', remote);
    writeFileSync(join(repository, 'package.json'), '{"version":"0.1.0"}');
    git('add', 'package.json');
    git('commit', '-m', 'initial');
    const initial = git('rev-parse', 'HEAD');
    let result = cut();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git('ls-remote', '--tags', 'origin', 'refs/tags/v0.1.0'), `${initial}\trefs/tags/v0.1.0`);
    result = cut();
    assert.equal(result.status, 0, result.stderr);
    git('tag', '-d', 'v0.1.0');
    git('tag', '-a', 'v0.1.0', '-m', 'annotated release');
    git('push', '--force', 'origin', 'refs/tags/v0.1.0');
    const annotated = git('rev-parse', 'v0.1.0');
    result = cut();
    assert.equal(result.status, 0, result.stderr);
    git('commit', '--allow-empty', '-m', 'different');
    result = cut();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /another commit/);
    assert.equal(git('ls-remote', '--tags', 'origin', 'refs/tags/v0.1.0'), `${annotated}\trefs/tags/v0.1.0`);
    for (const version of ['01.2.3', '1.0.0-beta', 'not-a-version']) {
      writeFileSync(join(repository, 'package.json'), JSON.stringify({ version }));
      result = cut();
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /stable semantic versions/);
    }
    writeFileSync(join(repository, 'package.json'), '{"version":"0.2.0"}');
    git('remote', 'set-url', 'origin', join(directory, 'missing.git'));
    result = cut();
    assert.notEqual(result.status, 0);
    assert.equal(git('tag', '--list', 'v0.2.0'), '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
