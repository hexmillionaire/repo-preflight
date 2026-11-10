import { codepoint, lineOf, RANK } from './util.mjs';

const BASENAMES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md', '.cursorrules', '.windsurfrules', 'skill.md']);

/** Files that coding agents load as instructions. */
export function isInstructionFile(rel) {
  const lower = rel.toLowerCase();
  const base = lower.split('/').pop();
  if (BASENAMES.has(base)) return true;
  if (base === 'copilot-instructions.md') return /(^|\/)\.github\/copilot-instructions\.md$/.test(lower);
  return /(^|\/)\.cursor\/rules\/.+\.mdc?$/.test(lower)
    || /(^|\/)\.github\/instructions\/.+\.instructions\.md$/.test(lower)
    || /(^|\/)\.claude\/(agents|commands|skills)\/.+\.md$/.test(lower)
    || /(^|\/)\.windsurf\/rules\/.+\.md$/.test(lower);
}

const HIDDEN = [
  { id: 'tag', severity: 'high', re: /[\u{E0000}-\u{E007F}]/gu, label: 'Unicode tag characters, which encode invisible text' },
  { id: 'bidi', severity: 'high', re: /[\u202a-\u202e\u2066-\u2069]/gu, label: 'bidirectional override characters, which reorder how text displays' },
  { id: 'selector', severity: 'high', re: /[\u{E0100}-\u{E01EF}]/gu, label: 'supplementary variation selectors, which can smuggle invisible bytes' },
  { id: 'zero-width', severity: 'medium', re: /[\u200b-\u200f\u2060-\u2064\ufeff\u180e\u061c\u00ad]/gu, label: 'zero-width or invisible formatting characters' },
];
const ANY_HIDDEN = /[\u{E0000}-\u{E007F}\u202a-\u202e\u2066-\u2069\u{E0100}-\u{E01EF}\u200b-\u200f\u2060-\u2064\ufeff\u180e\u061c\u00ad]/gu;

const URL = /\bhttps?:\/\/[^\s<>()[\]"'`]+/i;
const SUSPICIOUS_HOST = /^https?:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|[^/]*(pastebin\.com|paste\.ee|hastebin|gist\.githubusercontent\.com|raw\.githubusercontent\.com|transfer\.sh|ngrok|webhook\.site|requestbin|pipedream|interact\.sh|oast\.|burpcollaborator|trycloudflare\.com|workers\.dev|bit\.ly|tinyurl\.com))([/:?#]|$)/i;
const SECRET_PATH = /(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.netrc\b|\.git-credentials|\.docker\/config\.json|\.npmrc\b|\bkeychain\b|\bprivate keys?\b|\b(ANTHROPIC|OPENAI|GITHUB|GH|NPM|AWS_SECRET|AWS_ACCESS)_[A-Z_]*(KEY|TOKEN)\b)/i;
const ENV_FILE = /(^|[\s"'`(/])\.env(\.[a-z]+)?\b/i;
const SEND_VERB = /\b(send|upload|post|exfiltrat\w*|transmit|curl|wget|nc|netcat|webhook)\b/i;
const READ_VERB = /\b(send|upload|post|exfiltrat\w*|transmit|copy|cat|print|paste|share|include|read|base64|curl|wget|attach|output)\b/i;

// Each rule returns the matched trigger text or null. Ordered roughly by severity.
const LINE_RULES = [
  { id: 'override', severity: 'high', label: 'tells the agent to ignore earlier instructions',
    test: line => /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(previous|prior|above|earlier|preceding|all|any|other|system|safety|original)\b[^.\n]{0,30}?\b(instructions?|rules|prompts?|guidelines|directions|guardrails|polic(y|ies))\b/i.exec(line)?.[0] },
  { id: 'secrecy', severity: 'high', label: 'asks the agent to hide what it does from the user',
    test: line => /\b(do not|don't|dont|never|without)\s+(tell(ing)?|inform(ing)?|mention(ing)?|reveal(ing)?|show(ing)?|notify(ing)?|alert(ing)?|let(ting)?)\b[^.\n]{0,40}?\b(the )?(user|human|anyone|developer|operator|reviewer|owner)s?\b/i.exec(line)?.[0] },
  { id: 'download-exec', severity: 'high', label: 'downloads and runs code',
    test: line => (/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*?\|\s*(sudo\s+)?((ba|z|k|da|fi)?sh|python3?|node|perl|ruby|iex|Invoke-Expression|pwsh|powershell)\b/i.exec(line)
      ?? /\bbase64\s+(-d|--decode|-D)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/i.exec(line)
      ?? /\beval\s*["'`(]*\s*\$\(\s*(curl|wget)\b[^)]*/i.exec(line)
      ?? /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b[^)]*/i.exec(line))?.[0] },
  { id: 'exfiltration', severity: 'high', label: 'combines secrets with sending data somewhere',
    test: line => (SECRET_PATH.test(line) || ENV_FILE.test(line)) && SEND_VERB.test(line) && URL.test(line) ? (SECRET_PATH.exec(line) ?? ENV_FILE.exec(line))[0].trim() : null },
  { id: 'no-confirm', severity: 'medium', label: 'asks the agent to act without confirmation',
    test: line => /\bwithout\s+(asking|confirm(ing|ation)?|permission|approval|prompting|checking with)\b|\b(auto[- ]?approve|skip (all )?(confirmations?|permission (checks|prompts))|--dangerously-skip-permissions|bypassPermissions|--yolo)\b/i.exec(line)?.[0] },
  { id: 'role', severity: 'medium', label: 'tries to redefine the agent\'s role or instructions',
    test: line => /\b(you are now|from now on,? you|new (system )?instructions|(the |your )system prompt|developer message|act as (an? )?(unrestricted|jailbroken))\b/i.exec(line)?.[0] },
  { id: 'secrets', severity: 'medium', label: 'mentions credential files or tokens together with an action',
    test: line => (SECRET_PATH.test(line) && READ_VERB.test(line)) || (ENV_FILE.test(line) && SEND_VERB.test(line)) ? (SECRET_PATH.exec(line) ?? ENV_FILE.exec(line))[0].trim() : null },
  { id: 'fetch-follow', severity: 'medium', label: 'tells the agent to fetch a URL and follow or run what it finds',
    test: line => URL.test(line) && /\b(follow|obey|execute|run|apply)\b[^.\n]{0,40}?\b(instructions?|steps|script|commands?|directions)\b/i.test(line) ? URL.exec(line)[0] : null },
  { id: 'fetch-url', severity: 'low', label: 'tells the agent to fetch a URL on a paste, tunnel, raw-content or IP host',
    test: line => { const url = URL.exec(line)?.[0]; return url && SUSPICIOUS_HOST.test(url) && /\b(fetch|download|curl|wget|visit|open|browse|navigate|retrieve|load|read|get|go to|post|send)\b/i.test(line) ? url : null; } },
  { id: 'fetch-url', severity: 'info', label: 'tells the agent to fetch a URL',
    test: line => { const url = URL.exec(line)?.[0]; return url && /\b(fetch|download|curl|wget|visit|browse|navigate to|retrieve|go to)\b/i.test(line) ? url : null; } },
  { id: 'run', severity: 'info', label: 'tells the agent to run a command',
    test: line => (/^\s*(?:[-*+>]\s*|\d+[.)]\s*)?(?:\*\*|__)?(?:always\s+|first,?\s+|please\s+|then\s+|you\s+(?:must|should|need to)\s+)?(?:run|execute|exec|invoke|install|source)\b[^\n]{0,60}/i.exec(line)
      ?? /\b(?:you must|always|before (?:you )?(?:start|begin|doing anything|making changes))\b[^.\n]{0,40}?\b(?:run|execute)\b[^\n]{0,40}/i.exec(line))?.[0] },
];

const TOOL_COMMENT = /^\s*(markdownlint|prettier|toc|eslint|cspell|vale|lint|begin|end|start|stop|region|endregion|omit|include|generated|auto-generated|do not edit|todo)\b/i;
const MAX_FINDINGS_PER_FILE = 100;

function matchRules(text) {
  const matches = [];
  for (const rule of LINE_RULES) {
    if (matches.some(match => match.rule.id === rule.id)) continue;
    const trigger = rule.test(text);
    if (trigger) matches.push({ rule, trigger: trigger.trim() });
  }
  return matches.sort((a, b) => RANK[b.rule.severity] - RANK[a.rule.severity]);
}

function decodeTags(line) {
  let out = '';
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

/** Heuristic findings for one agent instruction file. */
export function scanInstructionText(file, text) {
  const findings = [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split('\n');
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const lineNo = index + 1;
    for (const kind of HIDDEN) {
      const found = line.match(kind.re);
      if (!found) continue;
      const unique = [...new Set(found.map(codepoint))];
      const decoded = kind.id === 'tag' ? decodeTags(line) : '';
      findings.push({ severity: kind.severity, rule: 'instruction-hidden-unicode', line: lineNo,
        trigger: `${found.length}\u00d7 ${unique.slice(0, 4).join(', ')}${unique.length > 4 ? ', \u2026' : ''}`,
        excerpt: decoded ? `hidden text: "${decoded}" | ${line}` : line,
        detail: `Heuristic: line contains ${kind.label}. A model may read text a person reviewing the file cannot see.` });
    }
    // Match against the text with hidden characters removed and tag text decoded, so obfuscation does not dodge the rules.
    const plain = line.replace(ANY_HIDDEN, '') + (line.match(HIDDEN[0].re) ? ' ' + decodeTags(line) : '');
    const matches = matchRules(plain);
    if (matches.length) {
      const [top, ...rest] = matches;
      findings.push({ severity: top.rule.severity, rule: 'instruction-text', line: lineNo, trigger: top.trigger, excerpt: line,
        detail: `Heuristic: line ${top.rule.label}.${rest.length ? ` Also: ${rest.map(match => match.rule.label).join('; ')}.` : ''}` });
    }
  });
  const comments = /<!--([\s\S]*?)(?:-->|$)/g;
  for (let match; (match = comments.exec(body));) {
    const content = match[1];
    const line = lineOf(body, match.index);
    const flagged = matchRules(content.replace(ANY_HIDDEN, '')).filter(item => RANK[item.rule.severity] > RANK.info);
    let severity = 'low';
    let detail = 'Heuristic: HTML comment. Rendered Markdown hides it from people, but agents read it.';
    if (flagged.length || URL.test(content)) {
      severity = 'medium';
      detail += flagged.length ? ` Its text ${flagged[0].rule.label}.` : ' It contains a URL.';
    } else if (TOOL_COMMENT.test(content) || !content.trim()) {
      severity = 'info';
    }
    findings.push({ severity, rule: 'instruction-html-comment', line, trigger: '<!-- \u2026 -->', excerpt: content.trim(), detail });
  }
  findings.sort((a, b) => a.line - b.line || RANK[b.severity] - RANK[a.severity]);
  const limited = findings.length > MAX_FINDINGS_PER_FILE;
  return { findings: (limited ? findings.slice(0, MAX_FINDINGS_PER_FILE) : findings).map(item => ({ ...item, file, category: 'instructions', heuristic: true })), limited, total: findings.length };
}

export async function scanInstructionFiles(ctx, walked) {
  for (const entry of walked.entries) {
    if (entry.type !== 'file' || !isInstructionFile(entry.rel)) continue;
    const text = await ctx.readText(entry.abs, entry.rel);
    if (text === null) continue;
    const result = scanInstructionText(entry.rel, text);
    for (const finding of result.findings) ctx.add(finding);
    if (result.limited) ctx.notes.push({ kind: 'limit', file: entry.rel, message: `Showing the first ${MAX_FINDINGS_PER_FILE} of ${result.total} heuristic findings.` });
  }
}
