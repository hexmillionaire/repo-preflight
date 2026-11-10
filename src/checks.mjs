import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { commandText, findLine, isInside, toPosix, visible } from './util.mjs';

// Names that agent tooling and generators write to; a planted link there redirects the write.
export const WRITE_TARGETS = new Set(['claude.md', 'claude.local.md', 'agents.md', 'claude.generated.md', '.env']);

function linkVerdict(root, linkAbs, target) {
  const lexical = path.resolve(path.dirname(linkAbs), target);
  return { lexical, outside: path.isAbsolute(target) ? !isInside(root, path.resolve(target)) : !isInside(root, lexical) };
}

export async function scanSymlinks(ctx, walked, indexLinks = [], gitTop = null) {
  const worktreeLinks = new Set();
  for (const entry of walked.entries) {
    if (entry.type !== 'symlink') continue;
    worktreeLinks.add(entry.rel);
    let target;
    try {
      target = await readlink(entry.abs);
    } catch (error) {
      ctx.notes.push({ kind: 'error', file: entry.rel, message: `Could not read symlink (${error.code}).` });
      continue;
    }
    const { lexical, outside: lexicalOutside } = linkVerdict(ctx.root, entry.abs, target);
    // realpath follows the whole chain (including in-repo links in the target) without opening any file.
    let real = null;
    let broken = null;
    try { real = await realpath(entry.abs); } catch (error) { broken = error.code; }
    const outside = lexicalOutside || (real !== null && !isInside(ctx.root, real));
    const writeTarget = WRITE_TARGETS.has(path.basename(entry.rel).toLowerCase());
    const base = { category: 'symlink', file: entry.rel, trigger: `symlink -> ${target}`, excerpt: real ?? lexical };
    if (outside) {
      ctx.add({ ...base, rule: 'symlink-outside', severity: 'high',
        detail: broken
          ? `Dangling symlink whose target is outside the repository; a tool that writes ${writeTarget ? 'this file' : 'through it'} creates or overwrites that outside path.`
          : 'Resolves outside the repository; reading it exposes, and writing it changes, a file the repository does not own.' });
    } else if (broken && writeTarget) {
      ctx.add({ ...base, rule: 'symlink-dangling-write-target', severity: 'medium',
        detail: `Dangling symlink at a name agent tools write to (${broken}); a write lands at the link target instead.` });
    }
  }
  for (const link of indexLinks) {
    const abs = path.join(gitTop, ...link.path.split('/'));
    if (!isInside(ctx.root, abs)) continue;
    const rel = toPosix(path.relative(ctx.root, abs));
    if (worktreeLinks.has(rel)) continue;
    const { lexical, outside } = linkVerdict(ctx.root, abs, link.target);
    const writeTarget = WRITE_TARGETS.has(path.basename(rel).toLowerCase());
    const base = { category: 'symlink', file: rel, trigger: `index symlink -> ${link.target}`, excerpt: lexical };
    const note = ' It is recorded as a symlink (mode 120000) in the Git index, so a checkout with symlinks enabled creates it.';
    if (outside) {
      ctx.add({ ...base, rule: 'symlink-outside', severity: 'high', detail: 'Target is outside the repository.' + note });
    } else if (writeTarget) {
      const exists = await lstat(lexical).then(() => true, () => false);
      if (!exists) ctx.add({ ...base, rule: 'symlink-dangling-write-target', severity: 'medium', detail: 'Target does not exist, at a name agent tools write to.' + note });
    }
  }
}

/** JSON with // and /* comments and trailing commas (VS Code and devcontainer files). */
export function parseJsonc(text) {
  const out = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let comma = -1;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
      comma = -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; out.push(' '); continue; }
    if (c === ',') { comma = out.length; out.push(','); i++; continue; }
    if ((c === '}' || c === ']') && comma >= 0) out[comma] = ' ';
    if (!/\s/.test(c)) comma = -1;
    out.push(c);
    i++;
  }
  return JSON.parse(out.join(''));
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function loadJson(ctx, entry) {
  const text = await ctx.readText(entry.abs, entry.rel);
  if (text === null) return null;
  try {
    return { text, data: parseJsonc(text) };
  } catch (error) {
    ctx.notes.push({ kind: 'error', file: entry.rel, message: `Could not parse JSON: ${visible(error.message, 120)}` });
    return null;
  }
}

const RISKY_ENV = new Set(['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'RUBYOPT', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']);

function claudeSettings(ctx, entry, { text, data }) {
  if (!isObject(data)) return;
  const add = (severity, trigger, excerpt, detail, needle) =>
    ctx.add({ category: 'agent-config', rule: 'claude-settings', severity, file: entry.rel, line: findLine(text, needle ?? (typeof excerpt === 'string' ? excerpt : null)), trigger, excerpt, detail });
  if (isObject(data.hooks)) {
    for (const [event, matchers] of Object.entries(data.hooks)) {
      for (const matcher of Array.isArray(matchers) ? matchers : []) {
        const hooks = Array.isArray(matcher?.hooks) ? matcher.hooks : [matcher];
        for (const hook of hooks) {
          if (!isObject(hook)) continue;
          const label = `hooks.${event}${matcher?.matcher ? ` [${matcher.matcher}]` : ''}`;
          if (typeof hook.command === 'string') add('high', label, hook.command, `Claude Code runs this shell command on ${event} events without asking each time.`);
          else if (typeof hook.url === 'string') add('medium', label, hook.url, `Claude Code sends ${event} events to this URL.`);
          else if (hook.type) add('low', label, commandText(hook.prompt ?? hook.type), `Claude Code runs a ${visible(hook.type, 20)} hook on ${event} events.`);
        }
      }
    }
  }
  if (isObject(data.statusLine) && typeof data.statusLine.command === 'string') add('high', 'statusLine.command', data.statusLine.command, 'Claude Code runs this command repeatedly to draw its status line.');
  for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper']) {
    if (typeof data[key] === 'string') add('high', key, data[key], 'Claude Code runs this command to obtain credentials or headers.');
  }
  const permissions = isObject(data.permissions) ? data.permissions : {};
  const others = [];
  for (const rule of Array.isArray(permissions.allow) ? permissions.allow : []) {
    if (typeof rule !== 'string') continue;
    if (/^Bash(\(\s*(\*|:\*|\*:\*)?\s*\))?$/.test(rule.trim())) add('high', 'permissions.allow', rule, 'Allows any shell command without a permission prompt.');
    else if (/^Bash\(/.test(rule)) add('medium', 'permissions.allow', rule, 'Pre-approves shell commands matching this rule; they run without a prompt.');
    else others.push(rule);
  }
  if (others.length) {
    add(others.some(rule => /^mcp__/.test(rule)) ? 'medium' : 'low', 'permissions.allow', others.slice(0, 8).join(', ') + (others.length > 8 ? ', \u2026' : ''),
      `Pre-approves ${others.length} non-shell tool rule(s) (edits, web fetches or MCP tools) without a prompt.`, others[0]);
  }
  if (typeof permissions.defaultMode === 'string') {
    const mode = permissions.defaultMode;
    if (mode === 'bypassPermissions' || mode === 'dontAsk') add('high', 'permissions.defaultMode', mode, 'Turns off permission prompts for every tool.');
    else if (mode === 'acceptEdits') add('medium', 'permissions.defaultMode', mode, 'Accepts file edits without a prompt.');
  }
  if (Array.isArray(permissions.additionalDirectories) && permissions.additionalDirectories.length) {
    add('medium', 'permissions.additionalDirectories', permissions.additionalDirectories.map(String).join(', '), 'Grants the agent access to directories outside this repository.', String(permissions.additionalDirectories[0]));
  }
  if (data.enableAllProjectMcpServers === true) add('high', 'enableAllProjectMcpServers', 'true', 'Auto-approves every MCP server in .mcp.json, so their commands start without a prompt.', 'enableAllProjectMcpServers');
  if (Array.isArray(data.enabledMcpjsonServers) && data.enabledMcpjsonServers.length) {
    add('medium', 'enabledMcpjsonServers', data.enabledMcpjsonServers.map(String).join(', '), 'Pre-approves these .mcp.json servers.', 'enabledMcpjsonServers');
  }
  if (isObject(data.env)) {
    const keys = Object.keys(data.env);
    for (const key of keys.filter(key => RISKY_ENV.has(key.toUpperCase()))) add('high', `env.${key}`, String(data.env[key]), 'Sets an environment variable that can load code, redirect API traffic or weaken TLS for every command the agent runs.', key);
    const rest = keys.filter(key => !RISKY_ENV.has(key.toUpperCase()));
    if (rest.length) add('low', 'env', rest.slice(0, 8).join(', '), `Sets ${rest.length} environment variable(s) for the agent session.`, rest[0]);
  }
  for (const key of ['enabledPlugins', 'extraKnownMarketplaces']) {
    if (isObject(data[key]) && Object.keys(data[key]).length) add('medium', key, Object.keys(data[key]).join(', '), 'Adds plugins or plugin marketplaces, which can bring tools, hooks and MCP servers.', key);
  }
}

function mcpServers(ctx, entry, { text, data }, key) {
  const servers = isObject(data) && isObject(data[key]) ? data[key] : null;
  if (!servers) return;
  for (const [name, server] of Object.entries(servers)) {
    if (!isObject(server)) continue;
    const base = { category: 'agent-config', rule: 'mcp-server', file: entry.rel, trigger: `${key}.${name}` };
    if (typeof server.command === 'string') {
      const excerpt = [server.command, ...(Array.isArray(server.args) ? server.args.map(String) : [])].join(' ');
      ctx.add({ ...base, severity: 'high', line: findLine(text, server.command), excerpt, detail: 'Starts this program as an MCP server once the server is enabled or approved, adding its tools to the agent.' });
    } else {
      const url = [server.url, server.httpUrl, server.serverUrl].find(value => typeof value === 'string');
      if (url) ctx.add({ ...base, severity: 'medium', line: findLine(text, url), excerpt: url, detail: 'Connects the agent to a remote MCP server whose tools it can call.' });
    }
  }
}

function vscodeTasks(ctx, entry, { text, data }) {
  for (const task of isObject(data) && Array.isArray(data.tasks) ? data.tasks : []) {
    if (!isObject(task) || task.runOptions?.runOn !== 'folderOpen') continue;
    const command = [task.command, ...(Array.isArray(task.args) ? task.args : [])].filter(item => item !== undefined).map(commandText).join(' ');
    ctx.add({ category: 'agent-config', rule: 'vscode-task', severity: 'high', file: entry.rel, line: findLine(text, 'folderOpen'),
      trigger: `task ${task.label ?? '(unnamed)'} runOn: folderOpen`, excerpt: command || commandText(task),
      detail: 'VS Code and its forks run this task when the folder opens, once automatic tasks are allowed for the workspace.' });
  }
}

const DEVCONTAINER_HOOKS = [
  ['initializeCommand', 'high', 'Runs on your host machine, outside the container, before it is built.'],
  ['onCreateCommand', 'medium', 'Runs inside the dev container when it is created.'],
  ['updateContentCommand', 'medium', 'Runs inside the dev container when content updates.'],
  ['postCreateCommand', 'medium', 'Runs inside the dev container after it is created.'],
  ['postStartCommand', 'medium', 'Runs inside the dev container every time it starts.'],
  ['postAttachCommand', 'medium', 'Runs inside the dev container every time a tool attaches.'],
];

function devcontainer(ctx, entry, { text, data }) {
  if (!isObject(data)) return;
  for (const [key, severity, detail] of DEVCONTAINER_HOOKS) {
    if (data[key] === undefined) continue;
    ctx.add({ category: 'agent-config', rule: 'devcontainer', severity, file: entry.rel, line: findLine(text, key), trigger: key, excerpt: commandText(data[key]), detail });
  }
}

function codexConfig(ctx, entry, text) {
  let server = null;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const header = /^\[\s*mcp_servers\.("?)([^\]"]+)\1\s*\]$/.exec(line);
    if (header) { server = header[2]; return; }
    if (line.startsWith('[')) { server = null; return; }
    const pair = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) return;
    const base = { category: 'agent-config', rule: 'codex-config', file: entry.rel, line: index + 1, excerpt: pair[2] };
    if (server && pair[1] === 'command') ctx.add({ ...base, severity: 'high', trigger: `mcp_servers.${server}.command`, detail: 'Codex starts this program as an MCP server for trusted projects.' });
    else if (server && pair[1] === 'url') ctx.add({ ...base, severity: 'medium', trigger: `mcp_servers.${server}.url`, detail: 'Connects Codex to a remote MCP server for trusted projects.' });
    else if (!server && pair[1] === 'notify') ctx.add({ ...base, severity: 'high', trigger: 'notify', detail: 'Codex runs this program after each turn for trusted projects.' });
    else if (!server && ['approval_policy', 'sandbox_mode'].includes(pair[1]) && /never|danger-full-access/.test(pair[2])) {
      ctx.add({ ...base, severity: 'high', trigger: pair[1], detail: 'Weakens Codex approvals or sandboxing for trusted projects.' });
    }
  });
}

export async function scanAgentConfigs(ctx, walked) {
  for (const entry of walked.entries) {
    if (entry.type !== 'file') continue;
    const lower = entry.rel.toLowerCase();
    const base = lower.split('/').pop();
    const parent = lower.split('/').slice(-2, -1)[0] ?? '';
    if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) {
      const json = await loadJson(ctx, entry);
      if (json) claudeSettings(ctx, entry, json);
    } else if (base === '.mcp.json' || (base === 'mcp.json' && parent === '.cursor')) {
      const json = await loadJson(ctx, entry);
      if (json) mcpServers(ctx, entry, json, 'mcpServers');
    } else if (base === 'mcp.json' && parent === '.vscode') {
      const json = await loadJson(ctx, entry);
      if (json) mcpServers(ctx, entry, json, 'servers');
    } else if (base === 'settings.json' && parent === '.gemini') {
      const json = await loadJson(ctx, entry);
      if (json) mcpServers(ctx, entry, json, 'mcpServers');
    } else if (base === 'tasks.json' && parent === '.vscode') {
      const json = await loadJson(ctx, entry);
      if (json) vscodeTasks(ctx, entry, json);
    } else if (base === '.devcontainer.json' || (base === 'devcontainer.json' && /(^|\/)\.devcontainer\//.test(lower))) {
      const json = await loadJson(ctx, entry);
      if (json) devcontainer(ctx, entry, json);
    } else if (base === 'config.toml' && parent === '.codex') {
      const text = await ctx.readText(entry.abs, entry.rel);
      if (text !== null) codexConfig(ctx, entry, text);
    }
  }
}

const LIFECYCLE = new Map([
  ['preinstall', ['high', 'Runs automatically on npm/yarn/pnpm install in this package.']],
  ['install', ['high', 'Runs automatically on npm/yarn/pnpm install in this package.']],
  ['postinstall', ['high', 'Runs automatically on npm/yarn/pnpm install in this package.']],
  ['prepare', ['medium', 'Runs on a local npm install in this package and before npm pack and publish.']],
  ['preprepare', ['medium', 'Runs around the prepare script on local npm install.']],
  ['postprepare', ['medium', 'Runs around the prepare script on local npm install.']],
  ['prepublish', ['medium', 'Legacy hook that older npm versions run on local install.']],
  ['dependencies', ['medium', 'npm runs this after any change to node_modules.']],
]);

export async function scanPackages(ctx, walked) {
  const files = new Set(walked.entries.filter(entry => entry.type === 'file').map(entry => entry.rel));
  for (const entry of walked.entries) {
    if (entry.type !== 'file') continue;
    const base = entry.rel.split('/').pop();
    const dir = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/') + 1) : '';
    if (base === 'package.json') {
      const json = await loadJson(ctx, entry);
      const scripts = isObject(json?.data) && isObject(json.data.scripts) ? json.data.scripts : {};
      for (const [name, command] of Object.entries(scripts)) {
        const rule = LIFECYCLE.get(name);
        if (!rule || typeof command !== 'string') continue;
        ctx.add({ category: 'package', rule: 'package-script', severity: rule[0], file: entry.rel, line: findLine(json.text, `"${name}"`) ?? findLine(json.text, command), trigger: `scripts.${name}`, excerpt: command, detail: rule[1] });
      }
      if (json && files.has(`${dir}binding.gyp`) && !scripts.install && !scripts.preinstall) {
        ctx.add({ category: 'package', rule: 'package-script', severity: 'medium', file: entry.rel, trigger: 'binding.gyp', excerpt: 'node-gyp rebuild',
          detail: 'A binding.gyp next to package.json makes npm run node-gyp rebuild on install, compiling native code.' });
      }
    } else if (base === '.yarnrc.yml' || base === '.yarnrc' || base === '.npmrc') {
      const text = await ctx.readText(entry.abs, entry.rel);
      if (text === null) continue;
      const patterns = base === '.npmrc'
        ? [[/^\s*(script-shell)\s*=\s*(.+)$/i, 'high', 'npm runs every package script through this program.'], [/^\s*(node-options)\s*=\s*(.+)$/i, 'medium', 'npm passes these options to every Node process it starts (can --require code).']]
        : [[/^\s*(yarnPath|yarn-path)\s*[:\s]\s*(.+)$/, 'high', 'Yarn runs this JavaScript file instead of itself whenever yarn runs here.']];
      text.split('\n').forEach((line, index) => {
        for (const [pattern, severity, detail] of patterns) {
          const match = pattern.exec(line);
          if (match) ctx.add({ category: 'package', rule: 'package-manager-config', severity, file: entry.rel, line: index + 1, trigger: match[1], excerpt: match[2].trim(), detail });
        }
      });
    }
  }
}
