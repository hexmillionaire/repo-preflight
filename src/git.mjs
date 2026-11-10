import { spawn } from 'node:child_process';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCapped } from './fsutil.mjs';
import { isInside } from './util.mjs';

/**
 * Parses Git config text without Git. Returns { entries, errors } where each entry is
 * { section, subsection, key, value, line }. Section and key names are lower-cased; quoted
 * subsections keep their case. A key with no `=` has value null (Git's implicit true).
 */
export function parseGitConfig(text) {
  const entries = [];
  const errors = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let section = null;
  let subsection = null;
  const skipLine = () => { while (i < n && text[i] !== '\n') i++; };
  const blank = ch => ch === ' ' || ch === '\t';

  function parseValue() {
    let out = '';
    let pending = '';
    let quoted = false;
    while (blank(text[i])) i++;
    while (i < n) {
      const ch = text[i];
      if (ch === '\n') break;
      if (ch === '\r') { i++; continue; }
      if (!quoted && (ch === '#' || ch === ';')) { skipLine(); break; }
      if (ch === '"') { out += pending; pending = ''; quoted = !quoted; i++; continue; }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === '\n') { i += 2; line++; continue; }
        if (next === '\r' && text[i + 2] === '\n') { i += 3; line++; continue; }
        out += pending; pending = '';
        out += { n: '\n', t: '\t', b: '\b' }[next] ?? next ?? '';
        i += 2;
        continue;
      }
      if (!quoted && blank(ch)) { pending += ch; i++; continue; }
      out += pending + ch; pending = '';
      i++;
    }
    return out;
  }

  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (blank(c) || c === '\r') { i++; continue; }
    if (c === '#' || c === ';') { skipLine(); continue; }
    if (c === '[') {
      i++;
      let name = '';
      while (i < n && /[A-Za-z0-9.-]/.test(text[i])) name += text[i++];
      subsection = null;
      let bad = false;
      if (blank(text[i])) {
        while (blank(text[i])) i++;
        if (text[i] === '"') {
          i++;
          let sub = '';
          while (i < n && text[i] !== '"' && text[i] !== '\n') {
            if (text[i] === '\\' && i + 1 < n && text[i + 1] !== '\n') i++;
            sub += text[i++];
          }
          if (text[i] === '"') { i++; subsection = sub; } else bad = true;
        } else bad = true;
      }
      if (bad || text[i] !== ']' || !name) {
        errors.push(line);
        section = null;
        skipLine();
        continue;
      }
      i++;
      const dot = name.indexOf('.');
      if (subsection === null && dot !== -1) {
        subsection = name.slice(dot + 1).toLowerCase();
        name = name.slice(0, dot);
      }
      section = name.toLowerCase();
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const start = line;
      let key = '';
      while (i < n && /[A-Za-z0-9-]/.test(text[i])) key += text[i++];
      while (blank(text[i])) i++;
      let value = null;
      if (text[i] === '=') {
        i++;
        value = parseValue();
      } else if (i < n && !['\n', '\r', '#', ';'].includes(text[i])) {
        errors.push(line);
        skipLine();
        continue;
      }
      if (section === null) { errors.push(start); continue; }
      entries.push({ section, subsection, key: key.toLowerCase(), value, line: start });
      continue;
    }
    errors.push(line);
    skipLine();
  }
  return { entries, errors };
}

const FALSE = new Set(['false', 'no', 'off', '0', '']);
const TRUE = new Set(['true', 'yes', 'on', '1']);

/** Returns [severity, detail] for a config entry that runs a program or redirects Git, else null. */
export function gitConfigRule(entry) {
  const { section: s, subsection: sub, key: k } = entry;
  const raw = entry.value;
  const v = (raw ?? '').trim();
  const lower = v.toLowerCase();
  const plain = sub === null;
  if (s === 'core' && plain) {
    switch (k) {
      case 'fsmonitor':
        if (raw === null || TRUE.has(lower)) return ['low', 'Enables Git\'s built-in fsmonitor daemon; no repository program is named.'];
        if (FALSE.has(lower)) return null;
        return ['high', 'Git runs this program on status, diff, add and most other commands that read the index.'];
      case 'hookspath': return ['high', 'Git runs hooks from this directory instead of .git/hooks.'];
      case 'sshcommand': return v ? ['high', 'Git runs this command for every fetch, pull and push over SSH.'] : null;
      case 'pager': return v ? ['high', 'Git runs this program to page the output of log, diff, show and similar commands.'] : null;
      case 'editor': return v ? ['medium', 'Git runs this program whenever it opens an editor (commit, rebase -i, tag -a).'] : null;
      case 'askpass': return v ? ['medium', 'Git runs this program when it needs a password.'] : null;
      case 'gitproxy': return v ? ['medium', 'Git runs this program for git:// connections.'] : null;
      case 'alternaterefscommand': return v ? ['medium', 'Git runs this command while negotiating fetches and pushes.'] : null;
      case 'worktree': return ['medium', 'Points Git\'s working tree at a different directory.'];
      default: return null;
    }
  }
  if (s === 'sequence' && plain && k === 'editor' && v) return ['medium', 'Git runs this program for interactive rebase todo lists.'];
  if (s === 'diff') {
    if (plain && k === 'external' && v) return ['high', 'Git runs this program instead of its own diff.'];
    if (!plain && (k === 'command' || k === 'textconv') && v) return ['high', 'Git runs this program when diffing paths that .gitattributes assigns to this driver.'];
  }
  if (s === 'filter' && !plain && ['process', 'clean', 'smudge'].includes(k) && v) {
    return ['high', 'Git runs this program on checkout, add and status for paths that .gitattributes assigns to this filter.'];
  }
  if (s === 'merge' && !plain && k === 'driver' && v) return ['medium', 'Git runs this program when merging paths that .gitattributes assigns to this driver.'];
  if (s === 'pager' && plain && raw !== null && !TRUE.has(lower) && !FALSE.has(lower)) return ['high', 'Git runs this program to page the output of this command.'];
  if (s === 'alias' && plain && v.startsWith('!')) return ['medium', 'Shell alias: runs this command when someone types the alias.'];
  if (s === 'credential' && k === 'helper' && v) return ['medium', 'Git runs this credential helper when it needs credentials.'];
  if (s === 'gpg' && k === 'program' && v) return ['medium', 'Git runs this program to sign or verify commits and tags.'];
  if (s === 'submodule' && !plain && k === 'update' && v.startsWith('!')) return ['high', 'Git runs this command on git submodule update.'];
  if (s === 'uploadpack' && k === 'packobjectshook' && v) return ['medium', 'Runs when serving fetches (Git ignores it in repository config, but it signals intent).'];
  if (s === 'remote' && !plain && (k === 'uploadpack' || k === 'receivepack') && v) return ['medium', 'Git runs this program on the remote side of local and SSH fetches or pushes.'];
  if ((s === 'difftool' || s === 'mergetool') && !plain && (k === 'cmd' || k === 'path') && v) return ['medium', 'Git runs this program for git difftool / mergetool.'];
  if (s === 'protocol') {
    if (sub === 'ext' && k === 'allow' && lower !== 'never') return ['high', 'Allows the ext:: transport, which runs arbitrary commands as remotes.'];
    if (plain && k === 'allow' && lower === 'always') return ['medium', 'Allows every transport, including ext:: which runs commands.'];
  }
  if ((s === 'include' && plain && k === 'path') || (s === 'includeif' && !plain && k === 'path')) {
    return ['medium', 'Pulls another config file into this repository\'s Git configuration.'];
  }
  return null;
}

function entryName(entry) {
  return entry.subsection === null ? `${entry.section}.${entry.key}` : `${entry.section}.${entry.subsection}.${entry.key}`;
}

const KNOWN_HOOKS = new Map([
  ['applypatch-msg', 'git am'], ['pre-applypatch', 'git am'], ['post-applypatch', 'git am'],
  ['pre-commit', 'before every commit'], ['pre-merge-commit', 'before merge commits'], ['prepare-commit-msg', 'during every commit'],
  ['commit-msg', 'during every commit'], ['post-commit', 'after every commit'], ['pre-rebase', 'before rebase'],
  ['post-checkout', 'after checkout, switch and clone'], ['post-merge', 'after merge and pull'], ['pre-push', 'before push'],
  ['pre-receive', 'when receiving a push'], ['update', 'when receiving a push'], ['proc-receive', 'when receiving a push'],
  ['post-receive', 'after receiving a push'], ['post-update', 'after receiving a push'], ['reference-transaction', 'on every ref update'],
  ['push-to-checkout', 'when receiving a push'], ['pre-auto-gc', 'before automatic gc'], ['post-rewrite', 'after amend and rebase'],
  ['sendemail-validate', 'git send-email'], ['fsmonitor-watchman', 'when fsmonitor uses the hook'], ['post-index-change', 'after index writes'],
  ['p4-changelist', 'git p4'], ['p4-prepare-changelist', 'git p4'], ['p4-post-changelist', 'git p4'], ['p4-pre-submit', 'git p4'],
]);

async function hookEntries(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  const out = [];
  for (const name of names.sort()) {
    if (name.endsWith('.sample')) continue;
    const abs = path.join(dir, name);
    let stats;
    try { stats = await lstat(abs); } catch { continue; }
    if (stats.isDirectory()) continue;
    const symlink = stats.isSymbolicLink();
    // Git for Windows runs hook files regardless of mode bits.
    const executable = symlink || process.platform === 'win32' || (stats.mode & 0o111) !== 0;
    out.push({ name, abs, symlink, executable, known: KNOWN_HOOKS.has(name) });
  }
  return out;
}

async function firstLine(abs) {
  try {
    const read = await readCapped(abs, 256);
    return read && !read.notFile ? read.text.split('\n')[0] : null;
  } catch {
    return null;
  }
}

/** Finds the Git directory Git would use for `root`: .git here or in a parent, a gitdir: file, or a symlink. */
export async function discoverGit(root, ctx) {
  let dir = root;
  for (let hops = 0; hops < 128; hops++) {
    const dotGit = path.join(dir, '.git');
    let stats = null;
    try {
      stats = await lstat(dotGit);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (stats) {
      let gitDir = null;
      if (stats.isDirectory()) gitDir = dotGit;
      else if (stats.isSymbolicLink()) {
        const target = await readlink(dotGit).catch(() => '');
        ctx.add({ category: 'git', rule: 'git-dir-symlink', severity: 'medium', file: ctx.display(dotGit), trigger: '.git symlink', excerpt: target,
          detail: 'The .git entry is a symlink; Git follows it and uses whatever configuration and hooks it points at.' });
        gitDir = await realpath(dotGit).catch(() => null);
      } else if (stats.isFile()) {
        const read = await readCapped(dotGit, 4096);
        const match = read && !read.notFile ? /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(read.text) : null;
        if (match) gitDir = path.resolve(dir, match[1]);
      }
      if (!gitDir) {
        ctx.notes.push({ kind: 'error', file: ctx.display(dotGit), message: 'Found .git but could not resolve a Git directory from it.' });
        return null;
      }
      const gitStats = await stat(gitDir).catch(() => null);
      if (!gitStats?.isDirectory()) {
        ctx.notes.push({ kind: 'error', file: ctx.display(dotGit), message: 'The Git directory it names does not exist.' });
        return null;
      }
      let commonDir = gitDir;
      const common = await readCapped(path.join(gitDir, 'commondir'), 4096).catch(() => null);
      if (common && !common.notFile && common.text.trim()) commonDir = path.resolve(gitDir, common.text.trim());
      return { top: dir, dotGit, gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function scanConfigFile(file, ctx, git, depth, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let read;
  try {
    read = await readCapped(file, ctx.opts.maxFileBytes);
  } catch (error) {
    ctx.notes.push({ kind: 'error', file: ctx.display(file), message: `Could not read Git config (${error.code ?? error.message}).` });
    return;
  }
  if (!read) return;
  if (read.notFile) {
    if (read.stats.isSymbolicLink()) {
      ctx.add({ category: 'git', rule: 'git-config', severity: 'medium', file: ctx.display(file), trigger: 'config symlink', excerpt: await readlink(file).catch(() => ''),
        detail: 'Git config file is a symlink; Git reads whatever it points at. Not followed by this scan.' });
    }
    return;
  }
  if (read.truncated) ctx.notes.push({ kind: 'limit', file: ctx.display(file), message: `Read only the first ${ctx.opts.maxFileBytes} bytes.` });
  const { entries, errors } = parseGitConfig(read.text);
  if (errors.length) ctx.notes.push({ kind: 'info', file: ctx.display(file), message: `${errors.length} line(s) could not be parsed as Git config (first: line ${errors[0]}).` });
  for (const entry of entries) {
    const rule = gitConfigRule(entry);
    if (!rule) continue;
    const name = entryName(entry);
    let [severity, detail] = rule;
    const value = entry.value ?? '';
    if (entry.key === 'path' && (entry.section === 'include' || entry.section === 'includeif')) {
      const target = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(path.dirname(file), value);
      const local = isInside(ctx.root, target) || isInside(git.gitDir, target) || isInside(git.commonDir, target);
      if (local && depth < 4) {
        detail += ' Followed: findings in the included file are listed separately.';
        await scanConfigFile(target, ctx, git, depth + 1, seen);
      } else detail += local ? ' Not followed: include depth limit reached.' : ' Not followed: it is outside the repository.';
    }
    if (entry.section === 'core' && entry.key === 'hookspath' && value) {
      const target = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(git.top, value);
      if (target === os.devNull) {
        severity = 'low';
        detail = 'Hooks are disabled (hooksPath points at the null device).';
      } else if (!isInside(ctx.root, target) && !isInside(git.top, target)) {
        detail += ' The directory is outside the repository.';
      } else {
        const hooks = (await hookEntries(target).catch(() => [])).filter(hook => hook.executable && hook.known).map(hook => hook.name);
        if (hooks.length) detail += ` Hooks there that Git will run: ${hooks.join(', ')}.`;
      }
    }
    ctx.add({ category: 'git', rule: 'git-config', severity, file: ctx.display(file), line: entry.line, trigger: name, excerpt: entry.value === null ? '(set with no value)' : value, detail });
  }
}

async function scanHooks(ctx, git) {
  const dir = path.join(git.commonDir, 'hooks');
  let hooks;
  try {
    hooks = await hookEntries(dir);
  } catch (error) {
    ctx.notes.push({ kind: 'error', file: ctx.display(dir), message: `Could not list hooks (${error.code ?? error.message}).` });
    return;
  }
  for (const hook of hooks) {
    const excerpt = hook.symlink ? `-> ${await readlink(hook.abs).catch(() => '?')}` : await firstLine(hook.abs);
    const base = { category: 'git', rule: 'git-hook', file: ctx.display(hook.abs), trigger: `hook ${hook.name}`, excerpt };
    if (hook.known && hook.executable) {
      ctx.add({ ...base, severity: 'high', detail: `Git runs this hook automatically ${KNOWN_HOOKS.get(hook.name)}.${hook.symlink ? ' It is a symlink.' : ''}` });
    } else if (hook.executable) {
      ctx.add({ ...base, severity: 'low', detail: 'Executable file in the hooks directory. Git only runs standard hook names, so it does not run by itself.' });
    } else if (hook.known) {
      ctx.add({ ...base, severity: 'info', detail: 'Hook file is present but not executable; Git ignores it.' });
    }
  }
}

/** Absolute path of a git executable from absolute PATH entries outside the scanned tree. */
export async function findGit(exclude = []) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => dir && path.isAbsolute(dir));
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (exclude.some(root => isInside(root, resolved))) continue;
    const file = path.join(resolved, name);
    try {
      const stats = await stat(file);
      if (stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111))) return file;
    } catch {}
  }
  return null;
}

export function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat', NoDefaultCurrentDirectoryInExePath: '1' });
}

/** Isolation flags placed before every Git subcommand. Command-line config beats repository config. */
export function hardenedArgs(git) {
  return ['--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-c', 'diff.external=', '-c', 'core.pager=cat',
    '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false', `--git-dir=${git.gitDir}`, `--work-tree=${git.top}`];
}

function runGit(bin, args, { input = '', timeout = 15000, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    // cwd is outside the scanned tree so Windows never resolves a program from the repository.
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout, shell: false });
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { child.kill(); finish(reject, new Error('Git output exceeded the size limit.')); } else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
    child.on('error', error => finish(reject, error));
    child.on('close', (code, signal) => {
      if (code === 0) finish(resolve, Buffer.concat(chunks));
      else finish(reject, new Error(signal ? `Git stopped (${signal}).` : `Git exited ${code}: ${stderr.trim().split('\n')[0] ?? ''}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const MAX_INDEX_LINKS = 5000;

/** Symlinks recorded in the Git index (mode 120000) with their targets, read via hardened git. */
export async function indexSymlinks(ctx, git) {
  const bin = await findGit([ctx.root, git.top]);
  if (!bin) {
    ctx.notes.push({ kind: 'info', message: 'git not found on PATH; symlinks recorded only in the Git index were not checked.' });
    return [];
  }
  let listing;
  try {
    listing = await runGit(bin, [...hardenedArgs(git), 'ls-files', '--stage', '--full-name', '-z']);
  } catch (error) {
    ctx.notes.push({ kind: 'info', message: `Could not list the Git index (${error.message}); index symlinks were not checked.` });
    return [];
  }
  const links = [];
  for (const record of listing.toString('utf8').split('\0')) {
    const match = /^120000 ([0-9a-f]{40,64}) \d\t(.+)$/s.exec(record);
    if (match) links.push({ sha: match[1], path: match[2] });
  }
  if (links.length > MAX_INDEX_LINKS) {
    ctx.notes.push({ kind: 'limit', message: `Checked the first ${MAX_INDEX_LINKS} of ${links.length} index symlinks.` });
    links.length = MAX_INDEX_LINKS;
  }
  if (!links.length) return [];
  let blobs;
  try {
    blobs = await runGit(bin, [...hardenedArgs(git), 'cat-file', '--batch'], { input: links.map(link => link.sha).join('\n') + '\n' });
  } catch (error) {
    ctx.notes.push({ kind: 'info', message: `Could not read index symlink targets (${error.message}).` });
    return [];
  }
  let pos = 0;
  for (const link of links) {
    const newline = blobs.indexOf(10, pos);
    if (newline < 0) break;
    const header = blobs.toString('utf8', pos, newline);
    pos = newline + 1;
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) continue;
    const size = Number(match[1]);
    link.target = blobs.toString('utf8', pos, pos + Math.min(size, 4096));
    pos += size + 1;
  }
  return links.filter(link => typeof link.target === 'string');
}

export async function scanGit(ctx) {
  const git = await discoverGit(ctx.root, ctx);
  if (!git) {
    ctx.notes.push({ kind: 'info', message: 'No .git found; Git checks skipped.' });
    return null;
  }
  if (!isInside(ctx.root, git.gitDir)) ctx.notes.push({ kind: 'info', message: `Git directory is outside the scanned folder: ${git.gitDir}` });
  const seen = new Set();
  const configs = [path.join(git.commonDir, 'config'), path.join(git.gitDir, 'config'), path.join(git.gitDir, 'config.worktree')];
  for (const file of configs) await scanConfigFile(file, ctx, git, 0, seen);
  await scanHooks(ctx, git);
  const links = ctx.opts.git ? await indexSymlinks(ctx, git) : [];
  return { ...git, links };
}
