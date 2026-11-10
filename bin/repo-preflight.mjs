#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { formatJson, formatText, hasFindings, scan, SEVERITIES, VERSION } from '../src/index.mjs';

const usage = `repo-preflight ${VERSION}

What in this checkout can run code, change agent behaviour, or point files outside the repo?

Usage:
  repo-preflight [directory] [options]

Options:
  --json                    Machine-readable report on stdout
  --fail-on <severity>      Lowest severity that sets exit code 1: ${SEVERITIES.join(', ')} (default: low)
  --max-depth <n>           Directory depth limit (default: 25)
  --max-files <n>           Entry limit for the walk (default: 50000)
  --no-git                  Do not run git at all (skips symlinks recorded only in the Git index)
  --include-node-modules    Walk node_modules too
  -h, --help                Show this help
  -v, --version             Print the version

Nothing from the scanned directory is executed. Git config, hooks and agent files are read as text;
git itself runs only for ls-files/cat-file, with repository-config programs disabled.

Exit codes: 0 no findings at or above --fail-on; 1 findings; 2 usage or IO error.
`;

let json = false;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true, allowNegative: true, strict: true,
    options: {
      json: { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'low' },
      'max-depth': { type: 'string' },
      'max-files': { type: 'string' },
      git: { type: 'boolean', default: true },
      'include-node-modules': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  json = values.json;
  if (values.help) {
    process.stdout.write(usage);
  } else if (values.version) {
    console.log(VERSION);
  } else {
    if (positionals.length > 1) throw Object.assign(new Error('Give at most one directory.'), { code: 'USAGE' });
    if (!SEVERITIES.includes(values['fail-on'])) throw Object.assign(new Error(`--fail-on must be one of ${SEVERITIES.join(', ')}.`), { code: 'USAGE' });
    const number = (flag, fallback) => {
      if (values[flag] === undefined) return fallback;
      if (!/^\d+$/.test(values[flag])) throw Object.assign(new Error(`--${flag} must be a positive integer.`), { code: 'USAGE' });
      return Number(values[flag]);
    };
    const result = await scan(positionals[0] ?? '.', {
      git: values.git, includeNodeModules: values['include-node-modules'],
      maxDepth: number('max-depth', 25), maxFiles: number('max-files', 50000),
    });
    process.stdout.write(json ? formatJson(result) + '\n' : formatText(result));
    process.exitCode = hasFindings(result, values['fail-on']) ? 1 : 0;
  }
} catch (error) {
  const code = error.code === 'USAGE' || String(error.code).startsWith('ERR_PARSE_ARGS') ? 'USAGE' : 'IO';
  if (json) process.stdout.write(JSON.stringify({ tool: 'repo-preflight', version: VERSION, error: { code, message: error.message } }, null, 2) + '\n');
  console.error(`repo-preflight: ${error.message}${code === 'USAGE' ? '\nRun repo-preflight --help.' : ''}`);
  process.exitCode = 2;
}
