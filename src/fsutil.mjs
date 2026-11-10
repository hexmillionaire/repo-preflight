import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FILE_BYTES = 1024 * 1024;

// O_NOFOLLOW refuses a symlink swapped in after lstat; O_NONBLOCK keeps a swapped-in FIFO from hanging open().
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Reads at most `max` bytes of a regular file without following symlinks.
 * Returns null when the path does not exist, { notFile, stats } for anything that is not a
 * regular file, otherwise { text, truncated, size }.
 */
export async function readCapped(file, max = MAX_FILE_BYTES) {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!stats.isFile()) return { notFile: true, stats };
  const handle = await open(file, OPEN_FLAGS);
  try {
    const current = await handle.stat();
    const sameFile = !stats.ino || !current.ino || (current.ino === stats.ino && current.dev === stats.dev);
    if (!current.isFile() || !sameFile) {
      const error = new Error('File changed while it was being read.');
      error.code = 'ECHANGED';
      throw error;
    }
    const buffer = Buffer.alloc(Math.min(max, current.size));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { text: buffer.subarray(0, filled).toString('utf8'), truncated: current.size > max, size: current.size, mode: stats.mode };
  } finally {
    await handle.close();
  }
}

function typeOf(entry) {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()) return 'other';
  return null;
}

/**
 * Breadth-first walk that never follows symlinks. Skips every `.git` entry (the Git checks read
 * the Git directory separately) and, unless asked, `node_modules`.
 */
export async function walk(root, { maxDepth, maxFiles, includeNodeModules = false }) {
  const entries = [];
  const notes = [];
  const skipped = [];
  const queue = [{ abs: root, rel: '', depth: 0 }];
  let seen = 0;
  let truncated = false;
  let depthLimited = 0;
  for (let next = 0; next < queue.length && !truncated; next++) {
    const dir = queue[next];
    let dirents;
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true });
    } catch (error) {
      notes.push({ kind: 'error', file: dir.rel || '.', message: `Could not list directory (${error.code ?? error.message}).` });
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const rel = dir.rel ? `${dir.rel}/${dirent.name}` : dirent.name;
      if (dirent.name === '.git') continue;
      if (dirent.name === 'node_modules' && !includeNodeModules) {
        skipped.push(rel);
        continue;
      }
      if (seen >= maxFiles) {
        truncated = true;
        break;
      }
      seen++;
      const abs = path.join(dir.abs, dirent.name);
      let type = typeOf(dirent);
      if (type === null) {
        try {
          const stats = await lstat(abs);
          type = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
        } catch {
          continue;
        }
      }
      const depth = dir.depth + 1;
      entries.push({ rel, abs, type, depth });
      if (type === 'dir') {
        if (depth < maxDepth) queue.push({ abs, rel, depth });
        else depthLimited++;
      }
    }
  }
  if (truncated) notes.push({ kind: 'limit', message: `Stopped after ${maxFiles} entries (--max-files). Later files were not checked.` });
  if (depthLimited) notes.push({ kind: 'limit', message: `${depthLimited} director${depthLimited === 1 ? 'y' : 'ies'} at depth ${maxDepth} not entered (--max-depth).` });
  if (skipped.length) {
    const shown = skipped.slice(0, 5).join(', ');
    notes.push({ kind: 'info', message: `Skipped ${skipped.length} node_modules director${skipped.length === 1 ? 'y' : 'ies'} (${shown}${skipped.length > 5 ? ', \u2026' : ''}); use --include-node-modules to walk them.` });
  }
  return { entries, notes, seen, truncated, depthLimited, skipped };
}
