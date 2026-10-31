#!/usr/bin/env node
// Turns the Claude Code session history (~/.claude/projects/<folder>/*.jsonl) into one short Markdown digest.
// Reads only. Writes only the digest file (mode 600, in a private temp folder by default).
// Secrets are masked before anything is written. Dates are shown in local time.
//
// Usage: node digest.mjs [--days 7] [--out <file>] [--root <dir>] [--state <dir>] [--max-chars 180000] [--include-self]
// Options accept both "--days 14" and "--days=14". Unknown options are rejected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- arguments ----------
const VALUE_OPTS = new Set(['days', 'out', 'root', 'state', 'max-chars']);
const FLAG_OPTS = new Set(['include-self', 'help']);
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!m) fail(`Unexpected argument: "${a}"`);
  const [, name, inline] = m;
  if (FLAG_OPTS.has(name)) {
    if (inline !== undefined) fail(`--${name} takes no value`);
    opts[name] = true;
  } else if (VALUE_OPTS.has(name)) {
    const v = inline !== undefined ? inline : argv[i + 1];
    if (v === undefined || (inline === undefined && v.startsWith('--'))) fail(`--${name} needs a value`);
    if (inline === undefined) i++;
    opts[name] = v;
  } else {
    fail(`Unknown option: --${name}`);
  }
}
if (opts.help) {
  console.log('node digest.mjs [--days 7] [--out <file>] [--root <dir>] [--state <dir>] [--max-chars 180000] [--include-self]');
  process.exit(0);
}

const intOpt = (name, def, min, max) => {
  const raw = String(opts[name] ?? def).trim();
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    fail(`--${name} must be an integer between ${min} and ${max} (got: "${raw}")`);
  }
  return n;
};
const days = intOpt('days', 7, 1, 90);
const budget = intOpt('max-chars', 180000, 5000, 2000000);
const includeSelf = Boolean(opts['include-self']);
const home = os.homedir();
const root = opts.root ?? path.join(home, '.claude', 'projects');
const stateDir = opts.state ?? path.join(home, '.claude', 'improve-system');
const since = Date.now() - days * 86400000;
const IDLE_MS = 15 * 60000; // gap above which time is not counted as active
const SIMILARITY = 0.76; // Jaccard threshold for "close formulations"

if (!fs.existsSync(root)) fail(`No history in ${root}`, 1);

// ---------- secrets ----------
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\b(?:npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{50,})\b/g,
  /\b(?:sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]{16,}\b/g,
  /\b(?:SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,
  /\b(?:glpat|glptt)-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:hf_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{20,})\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@]+:[^\s@]+@/gi,
];
const KV_SECRET = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"']{8,}/gi;
const LONG_BLOB = /\b[A-Za-z0-9+/_-]{40,}={0,2}/g;
const redact = (t) => {
  if (!t) return t;
  let r = t;
  for (const re of SECRET_PATTERNS) r = r.replace(re, '[SECRET]');
  r = r.replace(KV_SECRET, '$1=[SECRET]');
  // long opaque strings that mix letters and digits (keys, hashes); keeps paths and words
  r = r.replace(LONG_BLOB, (m) => (/\d/.test(m) && /[a-zA-Z]/.test(m) && !m.includes('/') ? '[SECRET]' : m));
  return r;
};

// ---------- hints ----------
// Hints that the user corrects Claude. Only hints: Claude checks the context.
// The lists cover English and French so corrections typed in either language are flagged.
const CORRECTION_START = /^(non|no|nope|stop|arr[eê]te|attends|annule|revert)\b/i;
const CORRECTION_ANY = /(pas [çc]a|pas comme [çc]a|(c'est|ce n'est) pas ce que|je t'ai (d[ée]j[àa] )?dit|j'ai dit|je te l'ai dit|toujours pas|encore une fois|[çc]a (ne )?marche (toujours )?pas|tu as oubli[ée]|c'est faux|n'importe quoi|i (already )?told you|not what i|that's wrong|still (not|broken|failing)|you forgot)/i;
const isCorrection = (t) => CORRECTION_START.test(t) || CORRECTION_ANY.test(t);
const PERMISSION_DENIED = /(doesn't want to proceed|user rejected|was rejected by the user|permission (to use|denied)|user denied)/i;
const isSelfCommand = (name) => name === 'improve-system' || name.endsWith(':improve-system');

// ---------- helpers ----------
const normalize = (t) =>
  t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/https?:\/\/\S+/g, ' URL ')
    .replace(/(?:^|\s)(?:[~/]|\.\.?\/)[^\s]*/g, ' PATH ')
    .replace(/\d+/g, '#').replace(/[^\p{L}#\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokensOf = (n) => [...new Set(n.split(' ').filter((x) => x.length > 2))];

const resultText = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join(' ') : '';

const pad = (n) => String(n).padStart(2, '0');
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localStamp = (ms) => { const d = new Date(ms); return `${localDay(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const shortDay = (ms) => localDay(ms).slice(5);
const fmtMin = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)}`;
};
const homeRel = (p) => (p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || '?');

// ---------- instruction files ----------
// Files found on disk, not files proven to have been loaded by Claude Code.
// ~/.claude/CLAUDE.md applies everywhere: it is reported once in the header, not per folder.
const IMPORTS_AGENTS = /^\s*@\S*AGENTS\.md\b/m;
const describeInstruction = (p) => {
  let note = '';
  if (p.endsWith('CLAUDE.md')) {
    try { if (IMPORTS_AGENTS.test(fs.readFileSync(p, 'utf8'))) note = ' (imports @AGENTS.md)'; } catch {}
  }
  return homeRel(p) + note;
};
const instructionCache = new Map();
const instructionFiles = (cwd) => {
  if (!cwd) return 'unknown folder';
  if (instructionCache.has(cwd)) return instructionCache.get(cwd);
  let r;
  if (!fs.existsSync(cwd)) r = 'folder not found';
  else {
    const found = [];
    let dir = cwd;
    while (true) {
      const names = dir === home ? ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] : ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];
      for (const f of names) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) found.push(describeInstruction(p));
      }
      const parent = path.dirname(dir);
      if (parent === dir || dir === home) break;
      dir = parent;
    }
    r = found.length ? found.join(', ') : 'none';
  }
  instructionCache.set(cwd, r);
  return r;
};
const globalInstructions = path.join(home, '.claude', 'CLAUDE.md');

// ---------- read sessions ----------
const files = [];
for (const dir of fs.readdirSync(root)) {
  const full = path.join(root, dir);
  let st;
  try { st = fs.statSync(full); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.jsonl')) continue; // one level only: sub-agent transcripts are skipped on purpose
    const p = path.join(full, f);
    let fst;
    try { fst = fs.statSync(p); } catch { continue; }
    if (fst.isFile() && fst.mtimeMs >= since) files.push({ p, mtime: fst.mtimeMs });
  }
}
// Oldest first: a resumed session copies earlier messages into a new file, and the original keeps them.
files.sort((a, b) => a.mtime - b.mtime);

const skip = /^<(local-command|system-reminder|command-message|user-prompt-submit-hook|task-notification|bash-|ide_)/;
const seenUuids = new Set();
const sessions = [];
let selfSkipped = 0;
let duplicatesSkipped = 0;
let malformedTotal = 0;
let badDatesTotal = 0;
for (const { p, mtime } of files) {
  const s = {
    file: p, cwd: '', title: '', stamps: [], items: [], commands: {},
    tools: 0, errorsByTool: {}, denied: 0, interrupts: 0, corrections: 0,
  };
  const toolNames = new Map();
  let lines;
  try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { malformedTotal++; continue; }
    if (e.type === 'custom-title' && e.customTitle) s.title = redact(String(e.customTitle));
    if (e.type === 'summary' && e.summary && !s.title) s.title = redact(String(e.summary));
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.uuid) {
      if (seenUuids.has(e.uuid)) { duplicatesSkipped++; continue; }
      seenUuids.add(e.uuid);
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (e.timestamp && !Number.isFinite(ts)) badDatesTotal++;
    if (Number.isFinite(ts) && ts < since) continue;
    if (e.cwd) s.cwd = e.cwd;
    if (Number.isFinite(ts)) s.stamps.push(ts);
    const c = e.message?.content;
    if (e.type === 'assistant') {
      if (Array.isArray(c)) for (const x of c) if (x?.type === 'tool_use') { s.tools++; toolNames.set(x.id, x.name || '?'); }
      continue;
    }
    if (e.isMeta) continue;
    const parts = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    for (const part of parts) {
      if (!part) continue;
      if (part.type === 'tool_result') {
        if (!part.is_error) continue;
        if (PERMISSION_DENIED.test(resultText(part.content))) { s.denied++; continue; }
        const name = toolNames.get(part.tool_use_id) || '?';
        s.errorsByTool[name] = (s.errorsByTool[name] || 0) + 1;
        continue;
      }
      if (part.type !== 'text' || !part.text) continue;
      const text = part.text.trim();
      if (text.startsWith('[Request interrupted')) { s.interrupts++; s.items.push({ kind: 'interrupt' }); continue; }
      const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (cmd) {
        const name = cmd[1].trim();
        s.commands[name] = (s.commands[name] || 0) + 1;
        const a = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
        if (a && a[1].trim()) s.items.push({ kind: 'prompt', text: redact(`/${name} ${a[1].trim()}`), corr: false });
        continue;
      }
      if (skip.test(text) || text.startsWith('This session is being continued')) continue;
      const corr = isCorrection(text);
      if (corr) s.corrections++;
      s.items.push({ kind: 'prompt', text: redact(text), corr });
    }
  }
  if (!includeSelf && Object.keys(s.commands).some(isSelfCommand)) { selfSkipped++; continue; }
  if (!s.items.some((i) => i.kind === 'prompt')) continue;
  s.stamps.sort((a, b) => a - b);
  s.startMs = s.stamps.length ? s.stamps[0] : mtime;
  // Estimate only: sum observed gaps below the idle threshold; never call this working time.
  s.active = 0;
  for (let i = 1; i < s.stamps.length; i++) {
    const gap = s.stamps[i] - s.stamps[i - 1];
    if (gap > 0 && gap < IDLE_MS) s.active += gap;
  }
  sessions.push(s);
}
sessions.sort((a, b) => a.startMs - b.startMs);

// ---------- aggregates ----------
const byFolder = new Map();
for (const s of sessions) {
  const f = byFolder.get(s.cwd) || { sessions: 0, days: new Set(), msgs: 0, active: 0, corrections: 0, interrupts: 0, errors: 0 };
  f.sessions++;
  f.days.add(localDay(s.startMs));
  f.msgs += s.items.filter((i) => i.kind === 'prompt').length;
  f.active += s.active;
  f.corrections += s.corrections;
  f.interrupts += s.interrupts;
  f.errors += Object.values(s.errorsByTool).reduce((a, b) => a + b, 0);
  byFolder.set(s.cwd, f);
}

// Repeated messages. Exact matches through a Map; close formulations through Jaccard similarity with
// prefix filtering: tokens are ordered from rarest to most common, and two sets with similarity >= t
// always share a token among the first |x| - ceil(t*|x|) + 1 of each. Only those groups are compared.
const prompts = [];
sessions.forEach((s, idx) => {
  for (const it of s.items) {
    if (it.kind !== 'prompt') continue;
    const n = normalize(it.text);
    if (n.length < 20 || n.split(' ').length < 4) continue;
    prompts.push({ idx, it, n, tokens: tokensOf(n) });
  }
});
const df = new Map();
for (const pr of prompts) for (const t of pr.tokens) df.set(t, (df.get(t) || 0) + 1);
const byRarity = (a, b) => df.get(a) - df.get(b) || (a < b ? -1 : a > b ? 1 : 0);
const prefixOf = (tokens) => tokens.slice(0, tokens.length - Math.ceil(SIMILARITY * tokens.length) + 1);

const repeatGroups = [];
const exact = new Map();
const prefixIndex = new Map(); // token -> groups whose seed has it in its prefix
for (const pr of prompts) {
  pr.tokens.sort(byRarity);
  let group = exact.get(pr.n);
  if (!group && pr.tokens.length) {
    const own = new Set(pr.tokens);
    const tried = new Set();
    let best = 0;
    for (const t of prefixOf(pr.tokens)) {
      for (const g of prefixIndex.get(t) || []) {
        if (tried.has(g)) continue;
        tried.add(g);
        // Jaccard >= t is impossible when sizes differ too much.
        if (g.tokens.length < SIMILARITY * own.size || own.size < SIMILARITY * g.tokens.length) continue;
        let inter = 0;
        for (const x of g.tokens) if (own.has(x)) inter++;
        const sim = inter / (own.size + g.tokens.length - inter);
        if (sim >= SIMILARITY && sim > best) { best = sim; group = g; }
      }
    }
  }
  if (!group) {
    group = { tokens: pr.tokens, sample: pr.it.text, sessions: new Set(), where: [], occurrences: 0, variants: new Set() };
    repeatGroups.push(group);
    for (const t of prefixOf(pr.tokens)) {
      if (!prefixIndex.has(t)) prefixIndex.set(t, []);
      prefixIndex.get(t).push(group);
    }
  }
  exact.set(pr.n, group);
  group.occurrences++;
  group.variants.add(pr.n);
  if (!group.sessions.has(pr.idx)) {
    group.sessions.add(pr.idx);
    const s = sessions[pr.idx];
    group.where.push(`${shortDay(s.startMs)} ${homeRel(s.cwd)}`);
  }
}
const repeated = repeatGroups.filter((r) => r.sessions.size >= 2)
  .sort((a, b) => b.sessions.size - a.sessions.size || b.occurrences - a.occurrences)
  .slice(0, 30);

const errTotals = {};
for (const s of sessions) for (const [k, v] of Object.entries(s.errorsByTool)) errTotals[k] = (errTotals[k] || 0) + v;

let lastReport = '';
try {
  const dir = path.join(stateDir, 'reports');
  const reports = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  if (reports.length) lastReport = homeRel(path.join(dir, reports[reports.length - 1]));
} catch {}
const changelog = path.join(stateDir, 'changes.md');

// ---------- render ----------
const header = (() => {
  const L = [`# Claude Code sessions, last ${days} days`, ''];
  const ignored = [
    selfSkipped && `${selfSkipped} /improve-system sessions skipped`,
    duplicatesSkipped && `${duplicatesSkipped} events duplicated by resumed sessions skipped`,
  ].filter(Boolean).join(', ');
  L.push(`${sessions.length} sessions${ignored ? ` (${ignored})` : ''}. Secrets masked as [SECRET]. Dates in local time.`);
  L.push(`Data quality: ${malformedTotal} malformed JSONL lines skipped, ${badDatesTotal} invalid timestamps.`);
  L.push('Active time = estimate from gaps between events (< 15 min), not measured working time.');
  L.push(`Last report: ${lastReport || 'none'}. Change log: ${fs.existsSync(changelog) ? homeRel(changelog) : 'none'}.`);
  L.push(`Global instructions: ${fs.existsSync(globalInstructions) ? describeInstruction(globalInstructions) : 'no ~/.claude/CLAUDE.md'}.`);
  L.push('', '## By folder', '');
  const folders = [...byFolder.entries()].sort((a, b) => b[1].active - a[1].active);
  for (const [cwd, f] of folders) {
    L.push(`- ${homeRel(cwd)}: ${f.sessions} sessions over ${f.days.size} days, ${f.msgs} messages, ${fmtMin(f.active)} active, ${f.corrections} corrections ⚠️, ${f.interrupts} interruptions, ${f.errors} tool errors. Instruction files on disk: ${instructionFiles(cwd)}`);
  }
  if (Object.keys(errTotals).length) {
    L.push('', '## Errors by tool', '');
    L.push(Object.entries(errTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', '));
  }
  if (repeated.length) {
    L.push('', '## Messages repeated across sessions', '');
    for (const r of repeated) {
      const one = r.sample.replace(/\s+/g, ' ');
      const variants = r.variants.size > 1 ? `, ${r.variants.size} close wordings` : ', normalized match';
      L.push(`- ${r.sessions.size} sessions, ${r.occurrences} occurrences${variants} (${r.where.slice(0, 5).join(' ; ')}${r.where.length > 5 ? ' ; …' : ''}): ${one.length > 160 ? `${one.slice(0, 160)}…` : one}`);
    }
  }
  L.push('', '## Sessions', '', 'Legend: ⚠️ = possible correction (check the context), ⏹ = the user stopped Claude.', '');
  return L.join('\n');
})();

const renderSession = (s, limit) => {
  const L = [];
  const cmds = Object.entries(s.commands).map(([k, v]) => `/${k}${v > 1 ? ` ×${v}` : ''}`).join(', ');
  const errs = Object.entries(s.errorsByTool).map(([k, v]) => `${k} ×${v}`).join(', ');
  const msgs = s.items.filter((i) => i.kind === 'prompt').length;
  L.push(`### ${localStamp(s.startMs)} · ${homeRel(s.cwd)}${s.title ? ` · ${s.title}` : ''}`);
  L.push(`${msgs} messages, ${s.tools} tool calls, ${fmtMin(s.active)} estimated, ${s.corrections} ⚠️, ${s.interrupts} ⏹` +
    `${errs ? `, errors: ${errs}` : ''}${s.denied ? `, ${s.denied} permission denials` : ''}${cmds ? `, commands: ${cmds}` : ''}`);
  L.push(`File: ${homeRel(s.file)}`);
  for (const it of s.items) {
    if (it.kind === 'interrupt') { L.push('- ⏹ interrupted'); continue; }
    const one = it.text.replace(/\s+/g, ' ');
    L.push(`- ${it.corr ? '⚠️ ' : ''}${one.length > limit ? `${one.slice(0, limit)}…` : one}`);
  }
  L.push('');
  return L.join('\n');
};

// Fit the budget: shorten long messages first, then drop the oldest sessions. Each session is rendered once per limit.
const truncNote = (n) => (n ? `\n(truncated: ${n} oldest sessions left out, rerun with a smaller --days to see everything)\n` : '');
let limit = 600;
let blocks = sessions.map((s) => renderSession(s, limit));
const total = (bs, from) => header.length + truncNote(from).length + 1 + bs.slice(from).reduce((n, b) => n + b.length + 1, 0);
while (total(blocks, 0) > budget && limit > 120) {
  limit = Math.floor(limit * 0.7);
  blocks = sessions.map((s) => renderSession(s, limit));
}
let keepFrom = 0;
let size = total(blocks, 0);
while (size > budget && keepFrom < blocks.length - 1) {
  size -= blocks[keepFrom].length + 1;
  keepFrom++;
  size += truncNote(keepFrom).length - truncNote(keepFrom - 1).length;
}
let md = `${header}${truncNote(keepFrom)}\n${blocks.slice(keepFrom).join('\n')}`;
if (md.length > budget) md = `${md.slice(0, budget)}\n\n(truncated)\n`;

// ---------- write ----------
// Default: a fresh private folder (mode 700) so the digest never lands at a predictable shared path.
let out = opts.out;
if (!out) out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-system-')), 'digest.md');
const outDir = path.dirname(path.resolve(out));
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const tempOut = path.join(outDir, `.${path.basename(out)}.${process.pid}.tmp`);
try {
  fs.writeFileSync(tempOut, md, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tempOut, out);
  fs.chmodSync(out, 0o600);
} catch (error) {
  try { fs.rmSync(tempOut, { force: true }); } catch {}
  fail(`Could not write the digest: ${error.message}`, 1);
}
console.log(`${out}: ${sessions.length} sessions, ${md.length} characters${keepFrom ? `, ${keepFrom} oldest sessions left out` : ''}`);
console.log(`Delete after reading: ${opts.out ? `rm ${out}` : `rm -r ${outDir}`}`);
