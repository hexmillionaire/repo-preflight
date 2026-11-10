import path from 'node:path';

export const SEVERITIES = Object.freeze(['high', 'medium', 'low', 'info']);
export const RANK = Object.freeze({ high: 3, medium: 2, low: 1, info: 0 });

// Characters that can hide or reorder text, or drive a terminal: C0/C1 controls (except tab/newline,
// handled separately), soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// bidi controls, line/paragraph separators, invisible operators, BOM, tag characters and
// supplementary variation selectors.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export function codepoint(ch) {
  return 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

/** Single-line, printable, length-capped rendering of untrusted text. Hidden characters become <U+XXXX>. */
export function visible(value, max = 200) {
  if (value === null || value === undefined) return value ?? null;
  const text = String(value).replace(/[\t\n\r]+/g, ' ').replace(INVISIBLE, ch => `<${codepoint(ch)}>`);
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') + '\u2026' : text;
}

// JSON.stringify escapes U+0000-U+001F but leaves bidi, zero-width, tag and C1 characters raw.
// Escape them too so a JSON reader (often a model) never receives invisible characters.
const JSON_UNSAFE = /[\u007F-\u009F\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]/g;
export function jsonSafe(json) {
  return json.replace(JSON_UNSAFE, match => {
    let out = '';
    for (let i = 0; i < match.length; i++) out += '\\u' + match.charCodeAt(i).toString(16).padStart(4, '0');
    return out;
  });
}

export function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

export function lineOf(text, index) {
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Line number of the first occurrence of a value's raw or JSON-escaped form, or null. */
export function findLine(text, value) {
  if (typeof value !== 'string' || !value) return null;
  for (const needle of [value, JSON.stringify(value).slice(1, -1)]) {
    const index = text.indexOf(needle);
    if (index >= 0) return lineOf(text, index);
  }
  return null;
}

export function commandText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${commandText(item)}`).join('; ');
  return JSON.stringify(value);
}

export class PreflightError extends Error {
  constructor(message, code = 'IO') {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
  }
}
