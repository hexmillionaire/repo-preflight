import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scan } from '../src/index.mjs';
import { pick, put, tempDir, trySymlink } from './helpers.mjs';

test('working-tree symlinks that leave the repo, and dangling links at write targets, are reported', async t => {
  const dir = await tempDir(t);
  const repo = path.join(dir, 'repo');
  const outside = path.join(dir, 'outside');
  await put(outside, '.zshrc', '# shell profile\n');
  await put(outside, 'pkg/package.json', JSON.stringify({ scripts: { postinstall: 'node steal.js' } }));
  await put(repo, 'README.md', '# readme\n');
  if (!(await trySymlink('../outside/.zshrc', path.join(repo, 'CLAUDE.generated.md'), 'file'))) {
    t.skip('this OS account cannot create symlinks; index-symlink tests cover the logic');
    return;
  }
  await trySymlink(path.join(outside, 'missing', 'CLAUDE.md'), path.join(repo, 'CLAUDE.md'), 'file');
  await trySymlink('notes/missing.md', path.join(repo, 'AGENTS.md'), 'file');
  await trySymlink('../README.md', path.join(repo, 'docs', 'readme-link'), 'file');
  await trySymlink('../outside/pkg', path.join(repo, 'vendor'), 'dir');
  await trySymlink('b', path.join(repo, 'a'), 'file');
  await trySymlink('../outside/.zshrc', path.join(repo, 'b'), 'file');

  const result = await scan(repo, { git: false });
  const links = pick(result, item => item.category === 'symlink');
  const get = file => links.find(item => item.file === file);
  assert.equal(get('CLAUDE.generated.md').severity, 'high');
  assert.equal(get('CLAUDE.generated.md').trigger.replaceAll('\\', '/'), 'symlink -> ../outside/.zshrc');
  assert.match(get('CLAUDE.md').detail, /Dangling/);
  assert.equal(get('CLAUDE.md').severity, 'high');
  assert.equal(get('AGENTS.md').severity, 'medium');
  assert.equal(get('AGENTS.md').rule, 'symlink-dangling-write-target');
  assert.equal(get('docs/readme-link'), undefined);
  assert.equal(get('vendor').severity, 'high');
  assert.equal(get('a').severity, 'high', 'chain a -> b -> outside resolves outside');
  assert.equal(get('b').severity, 'high');
  assert.equal(pick(result, item => item.category === 'package').length, 0, 'the walk never follows a directory symlink');
});
