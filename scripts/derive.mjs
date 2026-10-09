/*
 * Turns raw Instagram data into what the site shows: a title, a kind
 * (showreel / client work / edit), a clean description, credits and names.
 * Pure functions, so `node scripts/derive.mjs` can print every title for review.
 */

const SELF = 'afrxz.fx';

/* ── text helpers ───────────────────────────────────────────────────── */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u200d\ufe0e\ufe0f⃣☀-➿←-⇿⬀-⯿〰〽]/gu;
const EMOTICON_RE = /(^|\s)(<3+|:\)+|:\(+|;\)|:D|xD|\^_\^)(?=\s|$)/gi;
const GENERIC_TAG_RE = /^(fyp|foryou|foryoupage|trending|trend|viral|explore|explorepage|reels?|reelsinstagram|instagram|insta|edit|edits|editor|editing|video|videoedit|aftereffects|ae|capcut|tamil.*|kollywood.*|love|vibe|vibes|status|music|song|songs|whatsappstatus|follow.*|like.*|share.*)$/i;
const CREDIT_LINE_RE = /^(ib|tn|ac|cvr|cw|c\/w|rm|bg|cc|sfx|vc|pc|ib\/tn|tn\/ib|ac\/ib|ac tn|tn ib ac)\b\s*[:\-–]?|^(spl|special) thanks\b|^thanks to\b/i;
const SKIP_LINE_RE = /^(follow\b|share (for|4) more|repost to|tags?\s*[!/+]|hashtags?\b|h a s h t a g s|just to stay active|just for content|might delete)/i;

export const clean = (s) => (s || '').normalize('NFKC');
const squash = (s) => s.replace(/[ \t]+/g, ' ').trim();
const stripEmoji = (s) => squash(s.replace(EMOJI_RE, ' ').replace(EMOTICON_RE, ' '));
const isNoise = (line) => !/[\p{L}\p{N}]/u.test(line.replace(/[#@][\w.]+/g, ''));

/* "V I N T A G E" → "VINTAGE"; "NNOV RAJA" → "Nnov Raja" (but LCU, LBW stay) */
function tidyCase(s) {
  s = s.replace(/\b(?:\p{L} ){2,}\p{L}\b/gu, (m) => m.replace(/ /g, ''));
  return s.replace(/\b\p{Lu}{4,}\b/gu, (w) => w[0] + w.slice(1).toLowerCase());
}

/* "#Sardar2" → "Sardar 2", "#LBW" → "LBW" */
const tagWord = (t) => {
  const w = t.replace(/^#/, '').replace(/(\p{L})(\d)/gu, '$1 $2');
  return w.charAt(0).toUpperCase() + w.slice(1);
};

export function personName(handle, people) {
  const raw = clean(people?.[handle]?.name || '');
  const name = stripEmoji(raw.split(/\s+[|•·–—-]\s+|\s*\|\s*/)[0]).replace(/[^\p{L}\p{N}\p{M} .'&-]/gu, '').trim();
  return name && /\p{L}/u.test(name) ? tidyCase(name) : null;
}

/* Mentions become names (or vanish if the account has none); inline hashtags
 * become words; a trailing run of hashtags is dropped. */
function humanize(line, people) {
  let s = clean(line);
  s = s.replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, '');
  s = s.replace(/@([A-Za-z0-9._]{1,30})/g, (_, h) => personName(h.replace(/\.+$/, ''), people) || '');
  s = s.replace(/#([\p{L}\p{N}_]+)/gu, (_, t) => tagWord(t));
  return s;
}

function titleLine(line, people) {
  // "…Seyyavum 🌝 @irfansview" → drop the tag; "…meets @pradeep" keeps it (it's part of the sentence)
  let s = clean(line).replace(/([\p{L}\p{N}\p{M}])(\s*[^\s\p{L}\p{N}\p{M}@][^\p{L}\p{N}@]*)(?:@[A-Za-z0-9._]+[^\p{L}\p{N}@]*)+$/u, '$1$2');
  s = humanize(s, people);
  s = s.replace(/^\s*(>>|<<|~|[-–—•*]+)\s*/, '');
  s = s.replace(/^(follow|share)\s+(for|4)\s+more(\s+edits)?\s*[!.]*\s*[-–—:|]*\s*/i, '');
  s = stripEmoji(s);
  s = s.replace(/\[[\d:]+\]|<<[\d:]+>>/g, '');
  s = s.replace(/\s+[xX]\s+(?=\p{Lu}|\p{N})/gu, ' × ');
  s = s.replace(/\((?:\s*(?:watch|wait|turn|sound|full|till|end|fully|on|it)\b)[^)]*\)/gi, ' ');
  s = s.replace(/\(\s*([^)]*?)\s*\)/g, (m, inner) => (inner ? `(${inner})` : ' '));
  s = s.replace(/\.{2,}/g, '…').replace(/\.\s+\(/g, ' (');
  s = tidyCase(s);
  s = s.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
  s = s.replace(/\s+([!?.,:;…])/g, '$1').replace(/\s*:\s*/g, ': ');
  s = s.replace(/[\s.,:;!?~…'"“”‘’|–—-]+$/u, '');
  s = squash(s);
  // lowercase captions get sentence case: "i wish i could…" → "I wish I could…"
  s = s.replace(/^\p{Ll}/u, (c) => c.toUpperCase()).replace(/\bi\b/g, 'I');
  return s;
}

const words = (s) => s.split(/\s+/).filter(Boolean);
const titleCase = (s) => s.replace(/(^|[\s(/-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());

const MAX_WORDS = 11;
function shorten(s) {
  if (words(s).length <= MAX_WORDS) return s;
  for (const re of [/(?<=[.!?…])\s+|\.{2,}\s*|\s+[-–—|]\s+|:\s+/, /,\s+/]) {
    const cut = s.split(re)[0].replace(/[.!?…,]+$/, '');
    if (words(cut).length >= 2 && words(cut).length <= MAX_WORDS) return cut;
  }
  return `${words(s).slice(0, 8).join(' ')}…`;
}

/* Patterns for commissioned work, whose captions are full sentences. */
const WORK_PATTERNS = [
  [/show\s*-?\s*reel/i, () => 'Showreel'],
  [/screened at (?:the )?([^.!\n]+?)\s*(?:!|\.|\n|$)/i, (m) => `Screened at the ${titleCase(m[1])}`],
  [/promo(?:tional (?:content|video|film)|s)? for (?:the )?([^.!:\n]+?)(?:\s+streaming|\s+on\s|\s*[.!:)]|\n|$)/i,
    (m, all) => `${m[1]} ${/promos\b/i.test(all) ? 'Promos' : 'Promo'}`],
  [/(?:meet|met) and work(?:ed)? with ([^.!\n]+?)(?:\s+today|\s+and\s|\s*[.!,]|\n|$)/i, (m) => `Working with ${m[1]}`],
  [/(trailer|audio|teaser) launch of ([^,.!\n]+?)(?:\s+movies?|\s+film|,|\.|\n|$)/i, (m) => `${titleCase(m[2])} ${titleCase(m[1])} Launch`],
];

export function deriveTitle(post, people = {}) {
  const text = clean(post.caption);
  const lines = text.split('\n').map((l) => l.trim())
    .filter((l, i) => l && (!isNoise(l) || (i === 0 && /@[A-Za-z0-9._]/.test(l)))); // "@someone 🫶" names the subject
  const head = humanize(text.split(/\n\s*\n/).slice(0, 2).join('\n'), people).slice(0, 600);
  if (kindOf(post) !== 'edit') {
    for (const [re, make] of WORK_PATTERNS) {
      const m = head.match(re);
      if (m) {
        const t = titleLine(make(m, head), {});
        if (t && words(t).length <= 10) return t;
      }
    }
  }
  for (const line of lines) {
    if (CREDIT_LINE_RE.test(line) || (SKIP_LINE_RE.test(line) && line !== lines[0])) continue;
    const t = titleLine(line, people);
    if (/[\p{L}\p{N}][\p{L}\p{M}\p{N}]/u.test(t)) return shorten(t);
  }
  const named = [...text.matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((m) => personName(m[1], people)).find(Boolean);
  if (named) return named;
  const tag = [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]).find((t) => !GENERIC_TAG_RE.test(t) && t.length > 2);
  if (tag) return titleCase(tagWord(tag));
  return post.location || 'Untitled cut';
}

/* ── kind: showreel, client work, or an edit ────────────────────────── */
const CLIENT_RE = /\bpromo(?:s|tional)?\b|editing team|show edit\s*:|screened at|got to (?:meet|work)|(?:meet|met) and work|work(?:ed|ing)? with @|official (?:promo|trailer|teaser|video|edit)|(?:audio|trailer|teaser)\s*(?:\/\s*\w+\s*)?launch|commissioned|for the client|brand film|ad film/i;
export function kindOf(post) {
  const first = clean(post.caption).split('\n')[0];
  if (/show\s*-?\s*reel/i.test(first)) return 'reel';
  if (post.owner && post.owner !== SELF) return 'client';
  const body = clean(post.caption).replace(/#[\p{L}\p{N}_]+/gu, ' ');
  return CLIENT_RE.test(body) ? 'client' : 'edit';
}

/* ── description, credits, people ───────────────────────────────────── */
export function describe(post, people = {}) {
  const text = clean(post.caption);
  const lines = text.split('\n').map((l) => l.trim());
  const credits = [];
  const out = [];
  let first = true;
  for (const line of lines) {
    if (!line || isNoise(line)) { if (out.length && out.at(-1) !== '') out.push(''); continue; }
    if (first) { // a short first line became the title; a long one is the story
      first = false;
      if (words(line).length <= 12) continue;
    }
    if (CREDIT_LINE_RE.test(line)) { credits.push(stripEmoji(line)); continue; }
    if (SKIP_LINE_RE.test(line)) continue;
    if (/^\(([^)]*,){4,}[^)]*\)$/.test(line)) continue;                 // keyword lists for search
    if (/^([@#][\w.]+[\s,]*)+$/u.test(line.replace(/[^\w@#.\s,]/g, ''))) continue; // only tags/mentions
    const t = stripEmoji(humanize(line, people)).replace(/\s+([!?.,:;])/g, '$1');
    if (/[\p{L}\p{N}][\p{L}\p{M}\p{N}]/u.test(t)) out.push(t);
  }
  const paras = out.join('\n').split(/\n{2,}|\n(?=\n)/).map((p) => squash(p.replace(/\n/g, ' '))).filter(Boolean);
  return { paragraphs: paras.slice(0, 6), credits: credits.slice(0, 4) };
}

export function featuring(post, people = {}) {
  const seen = new Set([SELF]);
  const out = [];
  const lines = clean(post.caption).split('\n').filter((l) => !CREDIT_LINE_RE.test(l.trim()));
  for (const m of lines.join('\n').matchAll(/@([A-Za-z0-9._]{1,30})/g)) {
    const h = m[1].replace(/\.+$/, '');
    if (seen.has(h)) continue;
    seen.add(h);
    const name = personName(h, people);
    if (name) out.push({ handle: h, name });
  }
  return out.slice(0, 12);
}

/* ── profile ────────────────────────────────────────────────────────── */
export function readProfile(profile = {}, people = {}) {
  const [name, ...roleParts] = clean(profile.fullName || 'Afraz Ali').split(/\s*\|\s*/);
  const bio = clean(profile.bio || '');
  const lines = bio.split('\n').map((l) => stripEmoji(l)).filter(Boolean);
  const age = bio.match(/^\s*(\d{2})\s*(?:\|\||\||•|·|yrs?|years)/i)?.[1] || null;
  const headline = lines[0]?.replace(/^\d{2}\s*(\|\||\||•|·)\s*/, '').trim() || roleParts.join(' ') || 'Video Editor';
  const clientLine = bio.split('\n').find((l) => /clients?\s*[:\-]/i.test(l)) || '';
  const clients = [...clientLine.matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((m) => m[1]);
  const notes = lines.slice(1).filter((l) => !/clients?\s*[:\-]/i.test(l));
  return { name: stripEmoji(name).trim(), role: roleParts.join(' ').trim() || 'Editor', age, headline, clients, notes };
}

/* ── duplicates: the same cut posted twice ──────────────────────────── */
const hamming = (a, b) => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};
export function findDuplicates(posts) {
  const dupes = new Map();
  const byAge = [...posts].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  for (let i = 0; i < byAge.length; i++) {
    const p = byAge[i];
    if (!p.hash || dupes.has(p.code)) continue;
    for (let j = i + 1; j < byAge.length; j++) {
      const q = byAge[j];
      if (!q.hash || dupes.has(q.code) || p.type !== q.type) continue;
      const dp = p.media?.[0]?.duration;
      const dq = q.media?.[0]?.duration;
      const sameLength = dp == null || dq == null || Math.abs(dp - dq) < 1.5;
      if (hamming(p.hash, q.hash) <= 5 && sameLength) dupes.set(q.code, p.code);
    }
  }
  return dupes; // later copy → the original it repeats
}

/* `node scripts/derive.mjs [data.json]` prints every derived title for review. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const file = process.argv[2] || new URL('../data/instagram.json', import.meta.url);
  const db = JSON.parse(readFileSync(file, 'utf8'));
  const posts = db.posts || db;
  for (const p of posts) {
    const post = typeof p.caption === "string" ? p : { code: p.code, caption: p.caption?.text || '', owner: p.user?.username };
    console.log(`${post.code.padEnd(12)} ${kindOf(post).padEnd(6)} ${deriveTitle(post, db.people)}`);
  }
}
