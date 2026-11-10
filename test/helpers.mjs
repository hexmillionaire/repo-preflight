// Shared fixture helpers. Every fixture is built in a fresh temp directory at test time.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../bin/repo-preflight.mjs', import.meta.url));
export const POSIX = process.platform !== 'win32';

export async function tempDir(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'repo-preflight-test-')));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// Git for Windows cannot read \\.\nul as a config file, so fixtures get a real empty config and an empty hooks directory.
const isolation = mkdtempSync(path.join(os.tmpdir(), 'repo-preflight-gitenv-'));
const EMPTY_CONFIG = path.join(isolation, 'empty.gitconfig');
const EMPTY_HOOKS = path.join(isolation, 'hooks');
writeFileSync(EMPTY_CONFIG, '');
mkdirSync(EMPTY_HOOKS);
process.on('exit', () => rmSync(isolation, { recursive: true, force: true }));

export function fixtureGitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
}

/** Git for building fixtures only; the fixtures are ours, but hooks and fsmonitor stay off anyway. */
export function git(repo, args, input) {
  return execFileSync('git', ['-c', `core.hooksPath=${EMPTY_HOOKS}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-C', repo, ...args],
    { env: fixtureGitEnv(), input, encoding: 'utf8', windowsHide: true });
}

export async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '--initial-branch=main']);
  return dir;
}

export async function put(root, rel, content = '', mode) {
  const file = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  if (mode !== undefined) await chmod(file, mode);
  return file;
}

/** Records a symlink in the Git index only (mode 120000), so no OS symlink privilege is needed. */
export function indexSymlink(repo, rel, target) {
  const sha = git(repo, ['hash-object', '-w', '--stdin'], target).trim();
  git(repo, ['update-index', '--add', '--cacheinfo', `120000,${sha},${rel}`]);
}

/** Creates a real symlink, or returns false where the OS needs a privilege we do not have. */
export async function trySymlink(target, link, type) {
  await mkdir(path.dirname(link), { recursive: true });
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS') return false;
    throw error;
  }
}

export function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, ...options });
}

export const pick = (result, predicate) => result.findings.filter(predicate);
export const byTrigger = (result, trigger) => result.findings.find(item => item.trigger === trigger);
