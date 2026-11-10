import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { gitConfigRule, hardenedArgs, gitEnv, parseGitConfig, scan } from '../src/index.mjs';
import { byTrigger, fixtureGitEnv, git, indexSymlink, initRepo, pick, POSIX, put, tempDir } from './helpers.mjs';

const exists = file => access(file).then(() => true, () => false);

test('parseGitConfig handles subsections, quoting, comments, continuations and implicit booleans', () => {
  const { entries, errors } = parseGitConfig([
    '[core]',
    '\tFSMonitor = "./watch me.sh" ; trailing comment',
    '\tbare',
    '[filter "LFS"]',
    '\tsmudge = git-lfs smudge -- %f',
    '[branch.Main]',
    '\tremote = origin',
    '[alias]',
    '\tx = !echo \\',
    '  continued # comment',
    '[core] pager = less -R',
    '[bad',
  ].join('\n'));
  const get = name => entries.find(entry => `${entry.section}.${entry.subsection === null ? '' : entry.subsection + '.'}${entry.key}` === name);
  assert.equal(get('core.fsmonitor').value, './watch me.sh');
  assert.equal(get('core.fsmonitor').line, 2);
  assert.equal(get('core.bare').value, null);
  assert.equal(get('filter.LFS.smudge').value, 'git-lfs smudge -- %f');
  assert.equal(get('branch.main.remote').value, 'origin');
  assert.equal(get('alias.x').value, '!echo   continued', 'Git keeps whitespace around a continuation');
  assert.equal(get('core.pager').value, 'less -R');
  assert.equal(get('core.pager').line, 11);
  assert.deepEqual(errors, [12]);
});

test('gitConfigRule ignores disabled values and flags program-running keys', () => {
  const rule = (section, subsection, key, value) => gitConfigRule({ section, subsection, key, value })?.[0] ?? null;
  assert.equal(rule('core', null, 'fsmonitor', 'false'), null);
  assert.equal(rule('core', null, 'fsmonitor', 'true'), 'low');
  assert.equal(rule('core', null, 'fsmonitor', './x.sh'), 'high');
  assert.equal(rule('core', null, 'pager', ''), null);
  assert.equal(rule('pager', null, 'log', 'false'), null);
  assert.equal(rule('pager', null, 'log', 'evil'), 'high');
  assert.equal(rule('alias', null, 'st', 'status'), null);
  assert.equal(rule('alias', null, 'x', '!rm -rf /'), 'medium');
  assert.equal(rule('user', null, 'name', 'x'), null);
  assert.equal(rule('protocol', 'ext', 'allow', 'always'), 'high');
});

test('hardened git invocation disables repository programs and strips GIT_* env', () => {
  const args = hardenedArgs({ gitDir: '/r/.git', top: '/r' }).join(' ');
  for (const flag of ['core.fsmonitor=false', 'diff.external=', 'core.pager=cat', 'core.hooksPath=']) assert.ok(args.includes(flag), flag);
  process.env.GIT_DIR = '/tmp/elsewhere';
  try {
    const env = gitEnv();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  } finally {
    delete process.env.GIT_DIR;
  }
});

test('repo-local git config that executes programs is reported with file, line and trigger', async t => {
  const repo = await initRepo(path.join(await tempDir(t), 'repo'));
  await appendFile(path.join(repo, '.git', 'config'), [
    '[core]',
    '\tfsmonitor = ./watch.sh',
    '\thooksPath = .githooks',
    '\tsshCommand = ssh -o ProxyCommand=evil',
    '\tpager = ./pager.sh',
    '[diff]',
    '\texternal = ./difftool.sh',
    '[filter "x"]',
    '\tclean = ./clean.sh',
    '\tsmudge = ./smudge.sh',
    '\tprocess = ./process.sh',
    '[include]',
    '\tpath = ../extra.gitconfig',
    '',
  ].join('\n'));
  await put(repo, 'extra.gitconfig', '[core]\n\teditor = ./editor.sh\n');
  await put(repo, '.githooks/pre-commit', '#!/bin/sh\n', 0o755);
  const result = await scan(repo, { git: false });
  for (const trigger of ['core.fsmonitor', 'core.hookspath', 'core.sshcommand', 'core.pager', 'diff.external', 'filter.x.clean', 'filter.x.smudge', 'filter.x.process']) {
    const finding = byTrigger(result, trigger);
    assert.ok(finding, trigger);
    assert.equal(finding.severity, 'high', trigger);
    assert.equal(finding.file, '.git/config');
    assert.equal(finding.category, 'git');
    assert.equal(finding.heuristic, false);
  }
  assert.equal(byTrigger(result, 'core.fsmonitor').excerpt, './watch.sh');
  assert.ok(byTrigger(result, 'core.fsmonitor').line > 1);
  if (POSIX) assert.match(byTrigger(result, 'core.hookspath').detail, /pre-commit/);
  assert.equal(byTrigger(result, 'include.path').severity, 'medium');
  assert.equal(byTrigger(result, 'core.editor').file, 'extra.gitconfig');
});

test('executable hooks are reported; samples are ignored', { skip: !POSIX && 'mode bits are not meaningful on Windows' }, async t => {
  const repo = await initRepo(path.join(await tempDir(t), 'repo'));
  await put(repo, '.git/hooks/post-checkout', '#!/bin/sh\necho hi\n', 0o755);
  await put(repo, '.git/hooks/post-merge', '#!/bin/sh\n', 0o644);
  await put(repo, '.git/hooks/helper.sh', '#!/bin/sh\n', 0o755);
  const result = await scan(repo);
  const hook = byTrigger(result, 'hook post-checkout');
  assert.equal(hook.severity, 'high');
  assert.equal(hook.file, '.git/hooks/post-checkout');
  assert.equal(hook.excerpt, '#!/bin/sh');
  assert.equal(byTrigger(result, 'hook post-merge').severity, 'info');
  assert.equal(byTrigger(result, 'hook helper.sh').severity, 'low');
  assert.equal(pick(result, item => item.trigger.endsWith('.sample')).length, 0);
});

test('scanning never runs repository programs, even though plain git would', { skip: !POSIX && 'uses a POSIX shell script fixture' }, async t => {
  const dir = await tempDir(t);
  const repo = await initRepo(path.join(dir, 'repo'));
  await put(repo, 'README.md', 'hello\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'init']);
  const marker = path.join(dir, 'ran.txt');
  const script = await put(dir, 'payload.sh', `#!/bin/sh\necho ran >> "${marker}"\n`, 0o755);
  await put(repo, '.git/hooks/pre-commit', `#!/bin/sh\necho ran >> "${marker}"\n`, 0o755);
  await appendFile(path.join(repo, '.git', 'config'), `[core]\n\tfsmonitor = ${script}\n\tpager = ${script}\n[diff]\n\texternal = ${script}\n`);
  indexSymlink(repo, 'CLAUDE.md', '../outside.md');

  const result = await scan(repo);
  assert.equal(await exists(marker), false, 'scan must not execute fsmonitor, pager, diff.external or hooks');
  assert.equal(byTrigger(result, 'core.fsmonitor').severity, 'high');
  assert.ok(byTrigger(result, 'index symlink -> ../outside.md'), 'index was read through hardened git');

  // Control: an unhardened git status in the same repository does run the fsmonitor program.
  spawnSync('git', ['-C', repo, 'status', '--porcelain'], { env: fixtureGitEnv(), encoding: 'utf8' });
  assert.equal(await exists(marker), true, 'fixture should be live, otherwise the assertion above proves nothing');
});

test('symlinks recorded only in the Git index are checked without OS symlink support', async t => {
  const repo = await initRepo(path.join(await tempDir(t), 'repo'));
  await put(repo, 'README.md', '# x\n');
  indexSymlink(repo, 'CLAUDE.generated.md', '../../home/.zshrc');
  indexSymlink(repo, 'AGENTS.md', '/etc/passwd');
  indexSymlink(repo, 'docs/readme', '../README.md');
  indexSymlink(repo, '.env', 'missing.env');
  const result = await scan(repo);
  const links = pick(result, item => item.category === 'symlink');
  const get = file => links.find(item => item.file === file);
  assert.equal(get('CLAUDE.generated.md').severity, 'high');
  assert.equal(get('CLAUDE.generated.md').trigger, 'index symlink -> ../../home/.zshrc');
  assert.equal(get('AGENTS.md').severity, 'high');
  assert.equal(get('.env').severity, 'medium');
  assert.equal(get('docs/readme'), undefined, 'in-repo target is fine');

  const offline = await scan(repo, { git: false });
  assert.equal(pick(offline, item => item.category === 'symlink').length, 0, '--no-git skips index symlinks');
});

test('a .git file (worktree or submodule style) is followed to its Git directory', async t => {
  const dir = await tempDir(t);
  await put(dir, 'real-git/config', '[core]\n\tsshCommand = ./ssh.sh\n');
  await put(dir, 'checkout/.git', 'gitdir: ../real-git\n');
  const result = await scan(path.join(dir, 'checkout'), { git: false });
  const finding = byTrigger(result, 'core.sshcommand');
  assert.equal(finding.file, path.join(dir, 'real-git', 'config'));
  assert.ok(result.notes.some(note => /outside the scanned folder/.test(note.message)));
});

test('a directory with no Git metadata scans cleanly', async t => {
  const dir = await tempDir(t);
  await put(dir, 'notes.txt', 'plain\n');
  const result = await scan(dir);
  assert.equal(result.summary.total, 0);
  assert.equal(result.git, null);
});
