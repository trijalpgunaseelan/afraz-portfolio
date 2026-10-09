#!/usr/bin/env node
/*
 * Renders index.html from data/instagram.json (written by the sync) and
 * data/curation.json (optional hand edits). Every post appears exactly once:
 * the showreel in the hero, commissioned work under "Client work", everything
 * else in the edit bay. Re-posted copies of the same cut are dropped.
 *
 *   node scripts/build.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { deriveTitle, kindOf, describe, featuring, readProfile, personName, findDuplicates } from './derive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = (process.env.SITE_URL || 'https://afrazali.vercel.app').replace(/\/$/, '');
const SELF = 'afrxz.fx';
const IG = `https://www.instagram.com/${SELF}/`;
const DM = `https://ig.me/m/${SELF}`;

const db = JSON.parse(await readFile(path.join(ROOT, 'data/instagram.json'), 'utf8'));
const cur = existsSync(path.join(ROOT, 'data/curation.json'))
  ? JSON.parse(await readFile(path.join(ROOT, 'data/curation.json'), 'utf8')) : {};
const people = db.people || {};

/* ── helpers ────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;
const MEDIA_RE = /^assets\/ig\/[A-Za-z0-9_-]{5,40}\/(\d+(-t)?\.(webp|mp4)|reel\.mp4)$/;
const safeMedia = (p) => (MEDIA_RE.test(p || '') ? p : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const pad = (n) => String(Math.floor(n)).padStart(2, '0');
const mmss = (s) => (s == null ? '' : `${pad(s / 60)}:${pad(s % 60)}`);
const timecode = (s, fps = 25) => `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}:${pad((s % 1) * fps)}`;
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(n));
const handleName = (h) => personName(h, people) || h.replace(/[._]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const ratioClass = (m) => {
  const r = (m?.w || 9) / (m?.h || 16);
  return r > 1.3 ? 'ar-wide' : r > 0.92 ? 'ar-square' : r > 0.7 ? 'ar-45' : 'ar-916';
};
const runtime = (p) => p.media.reduce((t, m) => t + (m.video && m.duration ? m.duration : 0), 0);

/* ── posts → what the site shows ────────────────────────────────────── */
const overrides = cur.posts || {};
const hidden = new Set(cur.hide || []);
const dupes = findDuplicates(db.posts);
for (const [copy, original] of dupes) if (!overrides[copy]?.show) console.log(`duplicate: ${copy} repeats ${original}; hidden`);

const posts = db.posts
  .filter((p) => CODE_RE.test(p.code) && p.media?.length && !hidden.has(p.code) && (!dupes.has(p.code) || overrides[p.code]?.show))
  .map((p) => {
    const o = overrides[p.code] || {};
    const { paragraphs, credits } = describe(p, people);
    return {
      ...p,
      kind: o.kind || kindOf(p),
      title: o.title || deriveTitle(p, people),
      blurb: o.blurb ? [o.blurb] : paragraphs,
      credits,
      cast: featuring(p, people).filter((c) => !(o.title || deriveTitle(p, people)).toLowerCase().includes(c.name.toLowerCase()) && c.handle !== p.owner),
      year: p.takenAt.slice(0, 4),
      media: p.media.map((m) => ({ ...m, src: safeMedia(m.src), thumb: safeMedia(m.thumb), preview: safeMedia(m.preview), reel: safeMedia(m.reel) }))
        .filter((m) => m.src && m.thumb),
    };
  })
  .filter((p) => p.media.length);

// No two cuts share a title: later ones become "Take 2", "Take 3"…
const takes = new Map();
for (const p of [...posts].sort((a, b) => a.takenAt.localeCompare(b.takenAt))) {
  const key = p.title.toLowerCase();
  const n = (takes.get(key) || 0) + 1;
  takes.set(key, n);
  if (n > 1) p.title = `${p.title} · Take ${n}`;
}

const reel = posts.find((p) => p.kind === 'reel' && p.media[0].video) || null;
const work = posts.filter((p) => p !== reel && p.kind !== 'edit');
const edits = posts.filter((p) => p !== reel && p.kind === 'edit');
const years = [...new Set(edits.map((p) => p.year))].sort().reverse();

/* ── profile & credits ──────────────────────────────────────────────── */
const prof = readProfile(db.profile, people);
const clientHandles = [...new Set([
  ...prof.clients,
  ...work.map((p) => p.owner).filter((h) => h && h !== SELF),
  ...(cur.clients || []),
])];
const clients = clientHandles.map((h) => ({ handle: h, name: handleName(h) }));
const totalRuntime = posts.reduce((t, p) => t + runtime(p), 0);
const since = posts.length ? posts.map((p) => p.year).sort()[0] : null;
const highlights = (db.highlights || []).filter((h) => /^\d{5,30}$/.test(h.id) && /^assets\/ig\/_highlights\/\d+\.webp$/.test(h.cover));
const first = prof.name.split(' ')[0];
const about = cur.about?.length ? cur.about : [
  `${first} started cutting edits${since ? ` in ${since}` : ''}: tributes to the films he grew up on, timed to the beat.`,
  'That habit of cutting to the music now goes into client work, and the fan edits keep coming.',
];
const head = prof.headline.charAt(0).toUpperCase() + prof.headline.slice(1).toLowerCase();
const tagline = cur.tagline || `${head} cutting promos, launch films and edits, one beat at a time.`;
// bio lines already used elsewhere on the page (DMs → contact, clients → credits, highlights → stories)
const bioNotes = prof.notes.filter((n) => !/\bdm\b|clients?\b|highlight|repost/i.test(n));

/* ── pieces of markup ───────────────────────────────────────────────── */
const igUrl = (p) => `https://www.instagram.com/p/${p.code}/`;
const clipsLabel = (p) => {
  const v = p.media.filter((m) => m.video).length;
  if (p.media.length > 1) return `${p.media.length} ${v === p.media.length ? 'clips' : 'frames'}`;
  return p.media[0].video ? mmss(p.media[0].duration) : 'Still';
};
const kindLabel = { reel: 'Showreel', client: 'Client', edit: 'Edit' };

function mediaBlock(p, { sizes, eager = false, cls = '' } = {}) {
  const m = p.media[0];
  return `<span class="media ${ratioClass(m)} ${cls}">
      <img src="${m.thumb}" srcset="${m.thumb} 540w, ${m.src} 1080w" sizes="${sizes}" width="${m.w}" height="${m.h}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">
      ${m.preview ? `<video class="pv" muted loop playsinline preload="none" disablepictureinpicture data-src="${m.preview}" aria-hidden="true"></video>` : ''}
    </span>`;
}

const workCard = (p, i) => `
  <li class="cut cut--${ratioClass(p.media[0])}" data-year="${p.year}">
    <a class="cut-link" href="${igUrl(p)}" data-open="${p.code}" aria-label="Play ${esc(p.title)}">
      ${mediaBlock(p, { sizes: '(min-width: 1100px) 34vw, (min-width: 700px) 50vw, 100vw' })}
      <span class="cut-badge"><span class="dot"></span>C/${pad(i + 1)}</span>
      <span class="cut-len">${esc(clipsLabel(p))}</span>
    </a>
    <div class="cut-meta">
      <h3 class="cut-title">${esc(p.title)}</h3>
      <p class="cut-sub"><span>${monthYear(p.takenAt)}</span>${p.owner && p.owner !== SELF ? `<span>with ${esc(handleName(p.owner))}</span>` : ''}${p.type === 'carousel' ? '<span>Carousel</span>' : p.type === 'photo' ? '<span>Still</span>' : '<span>Reel</span>'}</p>
    </div>
  </li>`;

const editTile = (p, i) => `
  <li class="clip" data-year="${p.year}"${i >= 18 ? ' hidden' : ''}>
    <a class="clip-link" href="${igUrl(p)}" data-open="${p.code}">
      ${mediaBlock(p, { sizes: '(min-width: 1300px) 16vw, (min-width: 900px) 20vw, (min-width: 600px) 30vw, 46vw', cls: 'ar-fixed' })}
      <span class="clip-len">${esc(clipsLabel(p))}</span>
      <span class="clip-label y-${p.year}"></span>
      <span class="clip-title">${esc(p.title)}</span>
      <span class="clip-sub">${p.year}</span>
    </a>
  </li>`;

/* Viewer data: everything the player needs, keyed by post code. */
const viewer = {};
for (const p of [reel, ...work, ...edits].filter(Boolean)) {
  viewer[p.code] = {
    t: p.title,
    k: kindLabel[p.kind],
    d: monthYear(p.takenAt),
    b: p.blurb,
    c: p.credits,
    f: p.cast.map((c) => c.name),
    o: p.owner && p.owner !== SELF ? handleName(p.owner) : null,
    mu: p.music ? [p.music.title, p.music.artist].filter(Boolean).join(' — ') : null,
    m: p.media.map((m) => ({ s: m.src, w: m.w, h: m.h, ...(m.video ? { v: 1, p: m.preview, d: m.duration ?? null } : {}) })),
    ...(p.blocked ? { x: 1 } : {}),
  };
}
const viewerJson = JSON.stringify({ order: [reel, ...work, ...edits].filter(Boolean).map((p) => p.code), cuts: viewer })
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/* ── asset fingerprints so browsers can cache CSS/JS for a year ──────── */
const stamp = (rel) => `${rel}?v=${createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 10)}`;

/* ── social card ────────────────────────────────────────────────────── */
async function socialCard() {
  const out = path.join(ROOT, 'assets/og.jpg');
  const keyFile = path.join(ROOT, '.og-key');
  const src = reel?.media[0].src || work[0]?.media[0].src;
  if (!src) return;
  // only redrawn when its ingredients change, so builds stay reproducible
  const key = createHash('sha256').update(JSON.stringify([src, prof.name, prof.headline, readFileSync(path.join(ROOT, src)).length])).digest('hex');
  if (existsSync(out) && existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim() === key) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0a0a0b"/><stop offset=".55" stop-color="#0a0a0b" stop-opacity=".9"/><stop offset="1" stop-color="#0a0a0b" stop-opacity=".05"/></linearGradient></defs>
    <rect width="1200" height="630" fill="url(#g)"/>
    <circle cx="86" cy="96" r="9" fill="#ff3b2f"/>
    <text x="108" y="104" font-family="Menlo, DejaVu Sans Mono, monospace" font-size="24" fill="#9a968e" letter-spacing="3">EDIT SUITE · @${esc(SELF.toUpperCase())}</text>
    <text x="72" y="370" font-family="Georgia, DejaVu Serif, serif" font-size="150" fill="#f1eee8">${esc(prof.name)}</text>
    <text x="80" y="450" font-family="Helvetica, DejaVu Sans, Arial, sans-serif" font-size="38" fill="#c9c5bd">${esc(prof.headline)}</text>
    <rect x="80" y="520" width="520" height="4" rx="2" fill="#2a2a2e"/><rect x="80" y="520" width="190" height="4" rx="2" fill="#ff3b2f"/>
  </svg>`;
  const bg = await sharp(path.join(ROOT, src)).resize(1200, 630, { fit: 'cover', position: 'attention' }).modulate({ brightness: 0.8 }).toBuffer();
  await sharp(bg).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 82, mozjpeg: true }).toFile(out);
  await writeFile(keyFile, `${key}\n`);
}
await socialCard();

/* ── the page ───────────────────────────────────────────────────────── */
const heroMedia = reel?.media[0] || work[0]?.media[0];
const heroCode = reel?.code || work[0]?.code;
const heroVideo = reel?.media[0].reel || heroMedia?.preview;
const description = `${prof.name} — ${prof.headline.toLowerCase().startsWith('freelance') ? prof.headline : `${prof.headline}`}. ${posts.length} cuts: promos, launch films and edits. Clients include ${clients.slice(0, 3).map((c) => c.name).join(', ')}.`;
const ld = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Person',
  name: prof.name,
  jobTitle: prof.headline,
  url: SITE,
  sameAs: [IG],
  ...(db.profile.pic ? { image: `${SITE}/${db.profile.pic}` } : {}),
}).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(prof.name)} — ${esc(prof.role)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0a0a0b">
<meta name="color-scheme" content="dark">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="profile">
<meta property="og:url" content="${SITE}/">
<meta property="og:title" content="${esc(prof.name)} — ${esc(prof.role)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/assets/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/instrument-serif-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/geist-mono-latin.woff2" as="font" type="font/woff2" crossorigin>
${heroMedia ? `<link rel="preload" as="image" href="${heroMedia.thumb}" imagesrcset="${heroMedia.thumb} 540w, ${heroMedia.src} 1080w" imagesizes="(min-width: 900px) 30vw, 70vw" fetchpriority="high">` : ''}
<link rel="stylesheet" href="/${stamp('css/site.css')}">
<script type="application/ld+json">${ld}</script>
<script src="/${stamp('js/site.js')}" defer></script>
</head>
<body>
<div class="letterbox" aria-hidden="true"><span></span><span></span></div>
<a class="skip" href="#work">Skip to the work</a>

<header class="bar">
  <a class="brand" href="#top" aria-label="${esc(prof.name)}, back to top"><span class="rec" aria-hidden="true"></span><span class="brand-name">${esc(prof.name)}</span><span class="brand-role">${esc(prof.role)}</span></a>
  <nav class="tabs" aria-label="Sections">
    <a href="#work">Client work</a>
    <a href="#edits">Edits</a>
    ${highlights.length ? '<a href="#stories">Stories</a>' : ''}
    <a href="#about">About</a>
  </nav>
  <span class="tc" aria-hidden="true"><span class="tc-label">TC</span><span class="tc-val">00:00:00:00</span></span>
  <a class="btn btn--rec" href="#contact">Hire</a>
</header>

<main>
<section class="hero" id="top" aria-labelledby="hero-title">
  <div class="hero-copy">
    <p class="slate"><span>SC 01</span><span>TAKE 01</span><span>ROLLING</span></p>
    <h1 id="hero-title" class="display"><span class="d-1">${esc(prof.name.split(' ')[0])}</span> <em class="d-2">${esc(prof.name.split(' ').slice(1).join(' '))}</em></h1>
    <p class="lede">${esc(tagline)}</p>
    <div class="hero-actions">
      ${heroCode ? `<a class="btn btn--play" href="${igUrl({ code: heroCode })}" data-open="${heroCode}"><span class="tri" aria-hidden="true"></span>Play the showreel${reel ? `<span class="btn-tc">${mmss(reel.media[0].duration)}</span>` : ''}</a>` : ''}
      <a class="btn btn--ghost" href="#contact">Start a project</a>
    </div>
  </div>
  ${heroMedia ? `<figure class="monitor" aria-label="Showreel preview">
    <div class="monitor-frame ${ratioClass(heroMedia)}">
      <img src="${heroMedia.thumb}" srcset="${heroMedia.thumb} 540w, ${heroMedia.src} 1080w" sizes="(min-width: 900px) 30vw, 70vw" width="${heroMedia.w}" height="${heroMedia.h}" alt="" fetchpriority="high">
      ${heroVideo ? `<video class="hero-video" muted loop playsinline autoplay preload="metadata" disablepictureinpicture src="${heroVideo}" aria-hidden="true"></video>` : ''}
      <span class="safe" aria-hidden="true"></span>
      <span class="mon-tag" aria-hidden="true"><span class="dot"></span>PGM · ${reel ? 'SHOWREEL' : 'LATEST'}</span>
      <span class="mon-tc" aria-hidden="true">00:00:00:00</span>
    </div>
    <div class="meters" aria-hidden="true"><i></i><i></i></div>
    <figcaption class="mon-cap"><span>${reel ? esc(reel.title) : 'Latest cut'}</span><span>${reel ? monthYear(reel.takenAt) : ''}</span></figcaption>
  </figure>` : ''}
</section>

<section class="sec" id="work" aria-labelledby="work-title">
  <header class="sec-head">
    <p class="sec-kicker"><span class="trk">V1</span>Client work</p>
    <h2 id="work-title" class="sec-title">Cut for <em>the screen</em></h2>
    <div class="sec-aside">
      <p class="sec-note">${work.length} commissioned ${work.length === 1 ? 'cut' : 'cuts'}. Drag the strip, open any clip to watch it with sound.</p>
      <div class="rail-ctl"><button class="rail-btn" type="button" data-rail="-1" aria-label="Scroll back">←</button><button class="rail-btn" type="button" data-rail="1" aria-label="Scroll on">→</button></div>
    </div>
  </header>
  <ol class="cuts">${work.map(workCard).join('')}
  </ol>
  <div class="rail-bar" aria-hidden="true"><span></span></div>
</section>

<section class="sec" id="edits" aria-labelledby="edits-title">
  <header class="sec-head">
    <p class="sec-kicker"><span class="trk">V2</span>The edit bay</p>
    <h2 id="edits-title" class="sec-title">Every edit, <em>in his order</em></h2>
    <p class="sec-note">${edits.length} edits straight from his grid. Open any of them to watch with sound.</p>
  </header>
  <div class="bins" role="group" aria-label="Filter edits by year">
    <button class="bin is-on" type="button" data-bin="all" aria-pressed="true">All<span>${edits.length}</span></button>
    ${years.map((y) => `<button class="bin" type="button" data-bin="${y}" aria-pressed="false"><i class="y-${y}"></i>${y}<span>${edits.filter((p) => p.year === y).length}</span></button>`).join('\n    ')}
  </div>
  <ul class="clips" data-limit="18">${edits.map(editTile).join('')}
  </ul>
  ${edits.length > 18 ? `<div class="more-wrap"><button class="btn btn--ghost more" type="button">Show all ${edits.length} edits</button></div>` : ''}
</section>

${highlights.length ? `<section class="sec sec--tight" id="stories" aria-labelledby="stories-title">
  <header class="sec-head">
    <p class="sec-kicker"><span class="trk">A1</span>Story archive</p>
    <h2 id="stories-title" class="sec-title">Behind <em>the cuts</em></h2>
    <p class="sec-note">Project diaries kept as Instagram highlights. They open on Instagram.</p>
  </header>
  <ul class="stories">${highlights.map((h) => `
    <li><a class="story" href="https://www.instagram.com/stories/highlights/${h.id}/" target="_blank" rel="noopener noreferrer">
      <span class="story-ring"><img src="${h.cover}" width="120" height="120" alt="" loading="lazy" decoding="async"></span>
      <span class="story-title">${esc(h.title.trim() || 'Story')}</span>
    </a></li>`).join('')}
  </ul>
</section>` : ''}

<section class="sec about" id="about" aria-labelledby="about-title">
  <div class="pass" aria-label="Crew pass">
    <div class="pass-top"><span>ALL ACCESS</span><span class="pass-crew">CREW</span></div>
    ${db.profile.pic ? `<img class="pass-pic" src="${db.profile.pic}" width="160" height="160" alt="${esc(prof.name)}" loading="lazy" decoding="async">` : ''}
    <p class="pass-name">${esc(prof.name)}</p>
    <p class="pass-role">${esc(prof.role)}</p>
    <dl class="pass-facts">
      ${prof.age ? `<div><dt>Age</dt><dd>${esc(prof.age)}</dd></div>` : ''}
      <div><dt>Handle</dt><dd>@${SELF}</dd></div>
      ${since ? `<div><dt>Cutting since</dt><dd>${since}</dd></div>` : ''}
    </dl>
    <div class="pass-code" aria-hidden="true"></div>
  </div>
  <div class="about-copy">
    <p class="sec-kicker"><span class="trk">A2</span>About</p>
    <h2 id="about-title" class="sec-title">The person <em>at the timeline</em></h2>
    ${about.map((t) => `<p class="about-p">${esc(t)}</p>`).join('\n    ')}
    ${bioNotes.length ? `<ul class="bio">${bioNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <dl class="stats">
      ${db.profile.followers ? `<div><dt>Followers</dt><dd>${compact(db.profile.followers)}</dd></div>` : ''}
      <div><dt>Cuts on this page</dt><dd>${posts.length}</dd></div>
      <div><dt>Total runtime</dt><dd class="mono">${timecode(totalRuntime).slice(0, 8)}</dd></div>
    </dl>
    ${clients.length ? `<div class="credits" aria-label="Edited for">
      <p class="credits-role">Edited for</p>
      <ul class="credits-names">${clients.map((c) => `<li><a href="https://www.instagram.com/${esc(c.handle)}/" target="_blank" rel="noopener noreferrer">${esc(c.name)}</a></li>`).join('')}</ul>
    </div>` : ''}
  </div>
</section>

<section class="sec contact" id="contact" aria-labelledby="contact-title">
  <p class="sec-kicker"><span class="trk">EXP</span>Export</p>
  <h2 id="contact-title" class="contact-title">Let’s cut <em>something.</em></h2>
  <p class="contact-note">${esc(prof.notes.find((n) => /dm/i.test(n)) || 'DM for work')}. Build a quick brief and it’s copied for you, ready to paste into his DMs.</p>
  <form class="brief" id="brief" novalidate>
    <fieldset class="brief-row">
      <legend>What are we cutting?</legend>
      ${['Promo', 'Trailer / teaser', 'Launch event', 'Reel / edit', 'Music video', 'Something else'].map((t, i) => `<label class="chip"><input type="radio" name="type" value="${t}"${i === 0 ? ' checked' : ''}><span>${t}</span></label>`).join('')}
    </fieldset>
    <fieldset class="brief-row">
      <legend>When do you need it?</legend>
      ${['This week', 'This month', 'Flexible'].map((t, i) => `<label class="chip"><input type="radio" name="when" value="${t}"${i === 2 ? ' checked' : ''}><span>${t}</span></label>`).join('')}
    </fieldset>
    <div class="brief-grid">
      <label class="field"><span>Your name</span><input name="name" autocomplete="name" maxlength="80" required></label>
      <label class="field"><span>Brand / project</span><input name="project" maxlength="120"></label>
      <label class="field field--wide"><span>The idea</span><textarea name="idea" rows="4" maxlength="1200" placeholder="Footage you have, the vibe, references, length, where it will run…"></textarea></label>
    </div>
    <div class="brief-out">
      <button class="btn btn--rec btn--big" type="submit"><span class="dot"></span>Copy brief &amp; open DM</button>
      <a class="btn btn--ghost" href="${DM}" target="_blank" rel="noopener noreferrer">Just open Instagram DM</a>
      <p class="brief-status" role="status" aria-live="polite"></p>
    </div>
  </form>
</section>
</main>

<footer class="foot">
  <p><span class="rec" aria-hidden="true"></span>Rendered from <a href="${IG}" target="_blank" rel="noopener noreferrer">@${SELF}</a> on Instagram. New posts appear here automatically.</p>
  <p class="foot-sync">Last sync <time datetime="${db.updatedAt || ''}">${db.updatedAt ? `${db.updatedAt.slice(8, 10)} ${monthYear(db.updatedAt)}` : '—'}</time></p>
</footer>

<nav class="timeline" aria-label="Page timeline">
  <div class="tl-ruler" aria-hidden="true"></div>
  <div class="tl-track"></div>
  <div class="tl-head" aria-hidden="true"></div>
</nav>

<dialog class="viewer" aria-label="Player">
  <div class="v-top">
    <p class="v-tag"><span class="dot"></span><span class="v-kind"></span><span class="v-idx"></span></p>
    <div class="v-nav">
      <button class="v-btn" type="button" data-v="prev" aria-label="Previous cut">‹</button>
      <button class="v-btn" type="button" data-v="next" aria-label="Next cut">›</button>
      <button class="v-btn v-close" type="button" data-v="close" aria-label="Close player">✕</button>
    </div>
  </div>
  <div class="v-body">
    <div class="v-stage" tabindex="-1"></div>
    <aside class="v-info">
      <h2 class="v-title"></h2>
      <p class="v-sub"></p>
      <div class="v-clips" role="tablist" aria-label="Clips in this post"></div>
      <div class="v-desc"></div>
      <div class="v-cast"></div>
      <p class="v-keys" aria-hidden="true"><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> shuttle · <kbd>,</kbd><kbd>.</kbd> frame · <kbd>M</kbd> mute · <kbd>←</kbd><kbd>→</kbd> cuts</p>
      <a class="v-ig" href="${IG}" target="_blank" rel="noopener noreferrer">Open on Instagram ↗</a>
    </aside>
  </div>
  <div class="v-ctrl">
    <button class="v-play" type="button" aria-label="Play">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M7 4.5v15l13-7.5z"/><path class="i-pause" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
    </button>
    <span class="v-tc">00:00:00:00</span>
    <div class="v-scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <span class="v-buf"></span><span class="v-fill"></span><span class="v-knob"></span>
    </div>
    <span class="v-dur">00:00:00:00</span>
    <button class="v-mute" type="button" aria-label="Mute">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="i-on" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path class="i-off" d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <button class="v-full" type="button" aria-label="Full screen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
    </button>
  </div>
</dialog>

<script type="application/json" id="cuts">${viewerJson}</script>
</body>
</html>
`;

await writeFile(path.join(ROOT, 'index.html'), html);

// The clip endpoint only serves posts that are on the page.
const clips = Object.fromEntries(Object.entries(viewer).filter(([, v]) => !v.x).map(([code, v]) => [code, v.m.map((m, i) => (m.v ? i + 1 : 0)).filter(Boolean)]).filter(([, l]) => l.length));
await writeFile(path.join(ROOT, 'api/_clips.json'), `${JSON.stringify(clips)}\n`);

await writeFile(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc><lastmod>${(db.updatedAt || new Date().toISOString()).slice(0, 10)}</lastmod></url></urlset>\n`);

console.log(`index.html: showreel ${reel ? reel.code : '—'}, ${work.length} client cuts, ${edits.length} edits, ${highlights.length} highlights, ${clients.length} clients, runtime ${timecode(totalRuntime)}`);
