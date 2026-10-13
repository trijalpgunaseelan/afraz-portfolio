#!/usr/bin/env node
/*
 * Sync Afraz's public Instagram (@afrxz.fx) into the portfolio.
 *
 *   node scripts/sync-instagram.mjs                 new posts, profile, highlights, rotating re-check
 *   node scripts/sync-instagram.mjs --refresh-all   re-read every post (captions, posters, previews)
 *   node scripts/sync-instagram.mjs --probe A,B     diagnostics only: is each post still public?
 *
 * Writes data/instagram.json and assets/ig/<code>/ (n.webp poster, n-t.webp thumb,
 * n.mp4 muted preview loop). Titles, categories and descriptions are not stored
 * here: scripts/build.mjs derives them from the captions every time it renders,
 * so a caption edited on Instagram re-titles the post on the next sync.
 *
 * Works logged-out. From a home connection it reads the profile page (bio,
 * highlights, the whole grid in Afraz's own order). Cloud servers such as GitHub
 * Actions get a login wall there, so it falls back to Instagram's public embeds,
 * which list the newest posts and carry every video's file.
 *
 * Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg). Exit code 2 = Instagram refused us.
 */
import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const USERNAME = 'afrxz.fx';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data/instagram.json');
const MEDIA_DIR = 'assets/ig';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const ROTATION_SIZE = 16;               // older posts re-checked per run; every post about once a day
const RUN_EVERY_MS = 3 * 3600e3;        // matches the workflow's 3-hour schedule
const REMOVE_AFTER_MS = 6 * 3600e3;     // a post must be gone on two checks this far apart
const NAME_LOOKUPS_PER_RUN = +process.env.NAME_LOOKUPS || 40; // display names for @handles, cached in the data file
const NAME_TTL_DAYS = 120;
const argv = process.argv.slice(2);
const args = new Set(argv);
const REFRESH_ALL = args.has('--refresh-all');
const PROBE = args.has('--probe') ? (argv[argv.indexOf('--probe') + 1] || '').split(',').filter(Boolean) : null;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

class Blocked extends Error {}

// Everything read from Instagram is untrusted input.
const CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;                         // post codes become folder names
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const ID_RE = /^\d{5,30}$/;
const MEDIA_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;  // media only from Instagram's CDN
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const validCode = (c) => typeof c === 'string' && CODE_RE.test(c);
const validHandle = (h) => typeof h === 'string' && HANDLE_RE.test(h);
const isShowreel = (caption) => /show\s*-?\s*reel/i.test((caption || '').split('\n')[0]);

/* ── HTTP with a tiny cookie jar ─────────────────────────────────────── */
const jar = new Map();
const keepCookies = (res) => {
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
};
const KIND_HEADERS = {
  document: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
    'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
  },
  api: {
    accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
    origin: 'https://www.instagram.com', referer: `https://www.instagram.com/${USERNAME}/`,
  },
  image: {
    accept: 'image/avif,image/webp,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image',
    'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site', referer: 'https://www.instagram.com/',
  },
  video: {
    accept: '*/*', 'sec-fetch-dest': 'video', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site',
    referer: 'https://www.instagram.com/',
  },
  // what a browser sends when another website shows an Instagram embed in an iframe
  embed: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site',
    referer: 'https://afrazali.vercel.app/',
  },
};
const MEDIA_KINDS = new Set(['image', 'video']);
async function http(url, { kind = 'document', method = 'GET', body, headers = {}, tries = 4 } = {}) {
  for (let t = 1; t <= tries; t++) {
    let res;
    try {
      res = await fetch(url, {
        method, body, redirect: 'follow',
        headers: {
          'user-agent': UA, 'accept-language': 'en-US,en;q=0.9',
          'sec-ch-ua': '"Chromium";v="141", "Not?A_Brand";v="8"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
          ...(!MEDIA_KINDS.has(kind) && jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...KIND_HEADERS[kind], ...headers,
        },
      });
    } catch (e) {
      if (t === tries) throw e;
      await sleep(3000 * t);
      continue;
    }
    if (!MEDIA_KINDS.has(kind)) keepCookies(res);
    if (/\/accounts\/login|\/challenge\//.test(res.url)) throw new Blocked(`login wall at ${url}`);
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) { await res.body?.cancel(); await sleep(5000 * t); continue; }
    const text = await res.text().catch(() => '');
    // a media file failing is that file's problem; Instagram itself refusing us stops the run
    if (!MEDIA_KINDS.has(kind) && (res.status === 401 || res.status === 403)) throw new Blocked(`${res.status} at ${url}: ${text.slice(0, 160)}`);
    throw new Error(`${res.status} at ${url.slice(0, 120)}: ${text.slice(0, 160)}`);
  }
  if (MEDIA_KINDS.has(kind)) throw new Error(`gave up on ${url.slice(0, 120)} after ${tries} tries`);
  throw new Blocked(`gave up on ${url} after ${tries} tries`);
}

/* fetch() forces "sec-fetch-mode: cors", and Instagram only fills its embed
 * widget for real iframe navigations, so embeds go through plain https. */
function rawGet(url, headers, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...headers, 'accept-encoding': 'gzip, deflate' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects) {
        res.resume();
        resolve(rawGet(new URL(res.headers.location, url).href, headers, redirects - 1));
        return;
      }
      const enc = res.headers['content-encoding'];
      const body = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      body.on('data', (c) => chunks.push(c));
      body.on('end', () => resolve({ status: res.statusCode, url, text: Buffer.concat(chunks).toString('utf8') }));
      body.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`timeout at ${url}`)));
  });
}
async function embedGet(url, tries = 3) {
  const headers = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...KIND_HEADERS.embed };
  for (let t = 1; t <= tries; t++) {
    const res = await rawGet(url, headers).catch((e) => ({ status: 0, error: e }));
    if (res.url && /\/accounts\/login|\/challenge\//.test(res.url)) throw new Blocked(`login wall at ${url}`);
    if (res.status === 200) return res.text;
    if (res.status === 404) return '';
    if (res.status === 401 || res.status === 403) throw new Blocked(`${res.status} at ${url}`);
    await sleep(4000 * t);
  }
  throw new Blocked(`gave up on ${url} after ${tries} tries`);
}
function embedContext(html) {
  const raw = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(JSON.parse(`"${raw}"`)); } catch { return null; }
}

/* ── Server-rendered JSON helpers ────────────────────────────────────── */
function jsonBlobs(html) {
  const out = [];
  const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].length < 80) continue;
    try { out.push(JSON.parse(m[1])); } catch { /* not JSON we care about */ }
  }
  return out;
}
function findAll(obj, pred, acc = []) {
  if (obj && typeof obj === 'object') {
    if (!Array.isArray(obj) && pred(obj)) acc.push(obj);
    for (const v of Object.values(obj)) findAll(v, pred, acc);
  }
  return acc;
}
const parseCount = (s) => {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([KkMm])?/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
};
const str = (v, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');

/* ── Instagram reads: the profile page (home connections) ────────────── */
async function loadProfile() {
  const html = await (await http(`https://www.instagram.com/${USERNAME}/`)).text();
  const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  const queryId = html.match(/"queryID":"(\d+)","variables":\{"first":12,"username"/)?.[1];
  const blobs = jsonBlobs(html);
  const conn = blobs.flatMap((b) => findAll(b, (o) => o.polaris_ordered_timeline_connection))
    .map((o) => o.polaris_ordered_timeline_connection)[0];
  if (!conn) throw new Blocked('profile page had no posts (layout changed or blocked)');
  const user = blobs.flatMap((b) => findAll(b, (o) => o.username === USERNAME && 'biography' in o))[0] || {};
  const og = html.match(/<meta (?:property|name)="og:description" content="([^"]+)"/)?.[1] || '';
  const profile = {
    fullName: str(user.full_name, 200) || null,
    bio: str(user.biography, 1000) || null,
    links: (user.bio_links || []).map((l) => str(l.url, 500)).filter((u) => /^https:\/\//.test(u)),
    followers: user.follower_count ?? parseCount(og.match(/([\d.,]+[KkMm]?) Followers/)?.[1]),
    following: user.following_count ?? parseCount(og.match(/([\d.,]+[KkMm]?) Following/)?.[1]),
    posts: parseCount(og.match(/([\d.,]+[KkMm]?) Posts/)?.[1]),
    picUrl: str(user.profile_pic_url, 2000) || null,
  };
  const highlights = (user.lox_highlights_connection?.edges || []).map((e) => e.node).filter((n) => ID_RE.test(n?.id || ''))
    .map((n) => ({ id: n.id, title: str(n.title, 60), coverUrl: str(n.cover_media_cropped_thumbnail_url, 2000) }));
  return { lsd, queryId, conn, profile, highlights };
}

async function nextPage(p, cursor) {
  if (!p.lsd || !p.queryId) throw new Blocked('missing lsd/queryId for pagination');
  const body = new URLSearchParams({
    av: '0', __user: '0', __a: '1', lsd: p.lsd, doc_id: p.queryId, server_timestamps: 'true',
    fb_api_req_friendly_name: 'PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery',
    variables: JSON.stringify({ after: cursor, first: 12, username: USERNAME }),
  });
  const res = await http('https://www.instagram.com/api/graphql', {
    kind: 'api', method: 'POST', body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded', 'x-fb-lsd': p.lsd,
      'x-ig-app-id': '936619743392459', 'x-csrftoken': jar.get('csrftoken') || '',
    },
  });
  const text = (await res.text()).replace(/^for \(;;\);/, '');
  let json;
  try { json = JSON.parse(text); } catch { throw new Blocked(`pagination returned non-JSON: ${text.slice(0, 120)}`); }
  const conn = json?.data?.xig_user_by_username?.polaris_ordered_timeline_connection;
  if (!conn) throw new Blocked(`pagination returned no posts: ${text.slice(0, 160)}`);
  return conn;
}

async function listAllPosts(p) {
  const nodes = p.conn.edges.map((e) => e.node);
  let info = p.conn.page_info;
  while (info?.has_next_page) {
    await sleep(1500);
    const c = await nextPage(p, info.end_cursor);
    nodes.push(...c.edges.map((e) => e.node));
    info = c.page_info;
  }
  return nodes; // only returns once Instagram says there is no next page
}

async function loadPost(code) {
  const html = await (await http(`https://www.instagram.com/p/${code}/`)).text();
  const media = jsonBlobs(html).flatMap((b) => findAll(b, (o) => o.code === code && 'taken_at' in o))[0];
  if (!media) throw new Blocked(`post ${code} had no media data`);
  return media;
}

const TYPE = { 1: 'photo', 2: 'reel', 8: 'carousel' };
function fromPostPage(m) {
  const items = m.carousel_media?.length ? m.carousel_media : [m];
  const caption = str(m.caption?.text);
  const music = m.clips_metadata?.music_info?.music_asset_info;
  return {
    record: {
      code: m.code,
      type: TYPE[m.media_type] || 'photo',
      takenAt: new Date(m.taken_at * 1000).toISOString(),
      caption,
      location: str(m.location?.name, 200) || null,
      owner: validHandle(m.user?.username) ? m.user.username : USERNAME,
      coauthors: (m.coauthor_producers || []).map((u) => u.username).filter((u) => validHandle(u) && u !== USERNAME),
      tagged: (m.usertags?.in || []).map((t) => t.user?.username).filter(validHandle),
      music: music?.title ? { title: str(music.title, 200), artist: str(music.display_artist, 200) } : null,
      comments: m.comment_count ?? null,
    },
    sources: items.map((it) => ({
      image: it.image_versions2?.candidates?.[0]?.url || it.display_uri,
      video: it.media_type === 2 || it.video_versions ? it.video_versions?.[0]?.url || '' : null,
    })).filter((s) => s.image),
  };
}

/* ── Instagram reads: public embeds (work from cloud servers) ─────────
 * The profile embed lists the newest posts with their dates; each post's
 * embed carries the real video files, including every clip in a carousel. */
async function loadProfileEmbed() {
  const html = await embedGet(`https://www.instagram.com/${USERNAME}/embed/`);
  const ctx = embedContext(html)?.context;
  const media = (ctx?.graphql_media || []).map((g) => g.shortcode_media).filter(Boolean);
  if (!media.length) throw new Blocked('profile embed listed no posts');
  return {
    media,
    profile: {
      fullName: str(ctx.full_name, 200) || null,
      followers: parseCount(ctx.followers_count),
      posts: parseCount(ctx.posts_count),
      picUrl: str(ctx.profile_pic_url, 2000) || null,
    },
  };
}

/* `blocked`: the post uses licensed music, so Instagram keeps its video out
 * of embeds; the site then shows the preview and sends people to Instagram. */
async function loadPostEmbed(code) {
  const html = await embedGet(`https://www.instagram.com/p/${code}/embed/captioned/`);
  const ctx = embedContext(html);
  const sm = ctx?.gql_data?.shortcode_media;
  if (!sm || sm.shortcode !== code) throw new Error(`post embed for ${code} had no media`);
  return { sm, blocked: !!ctx.context?.copyright_blocked };
}

function fromEmbed(listed, full) {
  const sm = full || listed;
  const caption = str(sm.edge_media_to_caption?.edges?.[0]?.node?.text || listed.edge_media_to_caption?.edges?.[0]?.node?.text);
  const type = sm.__typename === 'GraphSidecar' ? 'carousel' : sm.is_video ? 'reel' : 'photo';
  const items = sm.edge_sidecar_to_children?.edges?.map((e) => e.node) || [sm];
  const best = (n) => (n.display_resources?.at(-1)?.config_width > 1000 ? n.display_resources.at(-1).src : n.display_url);
  const music = sm.clips_music_attribution_info;
  return {
    record: {
      code: listed.shortcode,
      type,
      takenAt: new Date(listed.taken_at_timestamp * 1000).toISOString(),
      caption,
      location: str(listed.location?.name, 200) || null,
      owner: validHandle(listed.owner?.username) ? listed.owner.username : USERNAME,
      coauthors: (listed.coauthor_producers || []).map((u) => u.username).filter((u) => validHandle(u) && u !== USERNAME),
      music: music && !music.uses_original_audio && music.song_name
        ? { title: str(music.song_name, 200), artist: str(music.artist_name, 200) } : null,
      comments: sm.edge_media_to_comment?.count ?? null,
    },
    sources: items.map((n) => ({ image: best(n), video: n.is_video ? n.video_url || '' : null })).filter((s) => s.image),
  };
}

/* Is a post still public? The post embed carries its shortcode when it is; a
 * removed post gets Instagram's "may have been removed" page. Anything else
 * (errors, a changed layout) is "unknown" and never deletes anything. */
async function postStatus(code) {
  const html = await embedGet(`https://www.instagram.com/p/${code}/embed/captioned/`);
  const ctx = embedContext(html);
  if (ctx?.context?.shortcode === code || ctx?.gql_data?.shortcode_media?.shortcode === code) {
    return { state: 'live', blocked: !!ctx.context?.copyright_blocked, comments: ctx?.gql_data?.shortcode_media?.edge_media_to_comment?.count ?? null };
  }
  if (/may have been removed|link to this photo or video may be broken/i.test(html)) return { state: 'gone' };
  return { state: 'unknown' };
}

/* Display names for @handles ("anirudhofficial" → "Anirudh Ravichander"), from
 * each account's public embed. Used for titles and credits on the site. */
async function lookupName(handle) {
  const html = await embedGet(`https://www.instagram.com/${handle}/embed/`);
  const ctx = embedContext(html)?.context;
  if (ctx?.username && ctx.username.toLowerCase() !== handle.toLowerCase()) return null;
  return str(ctx?.full_name, 120) || null;
}

/* ── Media: posters, thumbnails, preview loops ───────────────────────── */
const checkHost = (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !MEDIA_HOST_RE.test(u.hostname)) throw new Error(`refusing media host ${u.hostname}`);
};

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') reject(new Error(`${cmd} not found: install ffmpeg or set FFMPEG`));
      else resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function downloadVideo(url, file) {
  checkHost(url);
  const res = await http(url, { kind: 'video' });
  checkHost(res.url); // after redirects too
  if (!/^video\//i.test(res.headers.get('content-type') || '')) throw new Error('not a video');
  let bytes = 0;
  const limit = new TransformStream({
    transform(chunk, ctl) {
      bytes += chunk.byteLength;
      if (bytes > MAX_VIDEO_BYTES) ctl.error(new Error('video too large'));
      else ctl.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(limit)), createWriteStream(file));
}

async function probeDuration(file) {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file]);
  const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Math.round((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 100) / 100 : null;
}

/* A short, silent, small loop that plays on hover / in view. For the showreel
 * a longer, sharper loop plays behind the hero. */
async function encodePreview(input, output, duration, { long = false } = {}) {
  const len = long ? Math.min(duration || 30, 45) : Math.min(6, duration || 6);
  const start = long || !duration || duration <= 8 ? 0 : Math.min(duration * 0.22, duration - len);
  const edge = long ? 960 : 640;
  const { code, stderr } = await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', start.toFixed(2), '-i', input, '-t', len.toFixed(2),
    '-an', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', `scale=w='if(gte(iw,ih),${edge},-2)':h='if(gte(iw,ih),-2,${edge})':flags=lanczos,fps=25,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', long ? '27' : '30', '-profile:v', 'high',
    '-movflags', '+faststart', output,
  ]);
  if (code) throw new Error(`ffmpeg failed: ${stderr.slice(-300)}`);
}

async function dHash(file) {
  const px = await sharp(file).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

async function freshVideoUrl(code, i) {
  const { sm } = await loadPostEmbed(code);
  const items = sm.edge_sidecar_to_children?.edges?.map((e) => e.node) || [sm];
  const url = items[i]?.video_url;
  if (!url) throw new Error(`no fresh video link for ${code}/${i + 1}`);
  return url;
}

async function saveMedia(code, sources, { showreel = false } = {}) {
  if (!validCode(code)) throw new Error(`bad post code ${JSON.stringify(code)}`);
  const dir = path.join(ROOT, MEDIA_DIR, code);
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ig-'));
  const out = [];
  try {
    for (const [i, s] of sources.entries()) {
      const n = i + 1;
      const item = { src: `${MEDIA_DIR}/${code}/${n}.webp`, thumb: `${MEDIA_DIR}/${code}/${n}-t.webp` };
      const full = path.join(ROOT, item.src);
      const thumb = path.join(ROOT, item.thumb);
      if (REFRESH_ALL || !existsSync(full) || !existsSync(thumb)) {
        checkHost(s.image);
        const res = await http(s.image, { kind: 'image' });
        if (!/^image\//i.test(res.headers.get('content-type') || '')) throw new Error('not an image');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
        const img = sharp(buf).rotate();
        await img.clone().resize({ width: 1080, height: 1920, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 }).toFile(full);
        await img.clone().resize({ width: 540, height: 960, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72 }).toFile(thumb);
        await sleep(250);
      }
      ({ width: item.w, height: item.h } = await sharp(full).metadata());
      if (s.video != null) {
        item.video = true;
        const preview = `${MEDIA_DIR}/${code}/${n}.mp4`;
        const reel = `${MEDIA_DIR}/${code}/reel.mp4`;
        const wantReel = showreel && n === 1;
        if (REFRESH_ALL || !existsSync(path.join(ROOT, preview)) || (wantReel && !existsSync(path.join(ROOT, reel)))) {
          const file = path.join(tmp, `${n}.mp4`);
          try {
            if (!s.video) throw new Error('no video link');
            await downloadVideo(s.video, file);
          } catch (e) {
            // links from the post page sometimes fail; the post's embed hands out a fresh one
            log(`    ${code}/${n}: ${e.message.slice(0, 90)}; trying a fresh link`);
            await sleep(3000);
            await downloadVideo(await freshVideoUrl(code, i), file);
          }
          const duration = await probeDuration(file);
          await encodePreview(file, path.join(ROOT, preview), duration);
          if (wantReel) await encodePreview(file, path.join(ROOT, reel), duration, { long: true });
          item.duration = duration;
          await rm(file, { force: true });
        }
        item.preview = preview;
        if (wantReel) item.reel = reel;
      }
      out.push(item);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return out;
}

async function saveSmallImage(url, rel, size) {
  checkHost(url);
  const res = await http(url, { kind: 'image' });
  if (!/^image\//i.test(res.headers.get('content-type') || '')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  await mkdir(path.dirname(path.join(ROOT, rel)), { recursive: true });
  await sharp(buf).resize({ width: size, height: size, fit: 'cover' }).webp({ quality: 82 }).toFile(path.join(ROOT, rel));
  return rel;
}

/* Keep old media details (durations) when a post is re-read without new files. */
function mergeMedia(fresh, old) {
  return fresh.map((m, i) => ({ ...m, ...(m.video && m.duration == null && old?.[i]?.duration != null ? { duration: old[i].duration } : {}) }));
}

async function addPost(known, record, sources) {
  const old = known.get(record.code);
  const media = mergeMedia(await saveMedia(record.code, sources, { showreel: isShowreel(record.caption) }), old?.media);
  const hash = await dHash(path.join(ROOT, media[0].thumb));
  known.set(record.code, { ...old, ...record, media, hash, ...(old?.gridIndex != null && record.gridIndex == null ? { gridIndex: old.gridIndex } : {}) });
}

/* ── Full mode: the profile page + paginated grid + each post page ───── */
async function syncViaProfile(db, known) {
  if (process.env.IG_FORCE_EMBED) throw new Blocked('IG_FORCE_EMBED is set');
  const prof = await loadProfile();
  const nodes = (await listAllPosts(prof)).filter((n) => validCode(n.code));
  log(`Profile grid lists ${nodes.length} posts (${known.size} already in data).`);

  // Pagination ran to its end, so the grid is complete: anything we have that
  // is no longer on it was deleted (or archived) on Instagram.
  const listed = new Set(nodes.map((n) => n.code));
  const removed = nodes.length >= 6 ? [...known.keys()].filter((c) => !listed.has(c)) : [];
  for (const code of removed) {
    known.delete(code);
    if (validCode(code)) await rm(path.join(ROOT, MEDIA_DIR, code), { recursive: true, force: true });
    log(`  - ${code} removed (gone from Instagram)`);
  }

  // Afraz arranges his own grid, so the site keeps his order.
  nodes.forEach((n, i) => { if (known.has(n.code)) known.set(n.code, { ...known.get(n.code), gridIndex: i }); });

  const toFetch = nodes.filter((n) => !known.has(n.code) || REFRESH_ALL);
  log(`Reading ${toFetch.length} post page(s)…`);
  let added = 0;
  for (const node of toFetch) {
    const isNew = !known.has(node.code);
    try {
      const { record, sources } = fromPostPage(await loadPost(node.code));
      record.gridIndex = nodes.indexOf(node);
      if (record.type !== 'photo') record.blocked = await isBlocked(node.code);
      await addPost(known, record, sources);
      if (isNew) { added++; log(`  + ${node.code} ${record.type} ${record.takenAt.slice(0, 10)} ${record.caption.split('\n')[0].slice(0, 60)}`); }
    } catch (e) {
      if (e instanceof Blocked) throw e;
      console.warn(`  ! ${node.code}: ${e.message}`);
    }
    await sleep(1200);
  }

  // posts read before the licensed-music check existed
  const unchecked = [...known.values()].filter((p) => p.type !== 'photo' && p.blocked === undefined).slice(0, 60);
  if (unchecked.length) log(`Checking ${unchecked.length} post(s) for licensed music…`);
  for (const p of unchecked) {
    const blocked = await isBlocked(p.code);
    if (blocked !== undefined) known.set(p.code, { ...known.get(p.code), blocked });
    await sleep(900);
  }

  db.highlights = await saveHighlights(prof.highlights, db.highlights);
  return { added, removed, profile: prof.profile };
}

async function isBlocked(code) {
  try { return (await loadPostEmbed(code)).blocked; } catch (e) {
    if (e instanceof Blocked) throw e;
    return undefined;
  }
}

async function saveHighlights(list, old = []) {
  if (!list?.length) return old;
  const out = [];
  for (const h of list) {
    const rel = `${MEDIA_DIR}/_highlights/${h.id}.webp`;
    try {
      if (REFRESH_ALL || !existsSync(path.join(ROOT, rel)) || !old.some((o) => o.id === h.id && o.coverKey === coverKey(h.coverUrl))) {
        await saveSmallImage(h.coverUrl, rel, 240);
      }
      out.push({ id: h.id, title: h.title, cover: rel, coverKey: coverKey(h.coverUrl) });
    } catch (e) {
      console.warn(`  ! highlight ${h.id}: ${e.message}`);
    }
  }
  // drop covers of highlights that no longer exist
  for (const o of old) if (!out.some((h) => h.id === o.id) && ID_RE.test(o.id)) await rm(path.join(ROOT, MEDIA_DIR, '_highlights', `${o.id}.webp`), { force: true });
  return out;
}
// the image's file name identifies the cover; the URL's signature changes daily
const coverKey = (url) => (url || '').split('?')[0].split('/').pop() || null;

/* ── Embed mode: the profile embed + each post's embed ───────────────── */
async function syncViaEmbed(db, known) {
  const { media, profile } = await loadProfileEmbed();
  log(`Embed mode: profile embed lists the ${media.length} newest posts.`);
  let added = 0;
  const top = Math.min(0, ...[...known.values()].map((p) => p.gridIndex ?? 0));
  const fresh = media.filter((sm) => validCode(sm.shortcode) && (!known.has(sm.shortcode) || REFRESH_ALL));
  for (const [i, listed] of fresh.entries()) {
    const isNew = !known.has(listed.shortcode);
    try {
      const { sm, blocked } = await loadPostEmbed(listed.shortcode);
      const { record, sources } = fromEmbed(listed, sm);
      if (record.type !== 'photo') record.blocked = blocked;
      if (isNew) record.gridIndex = top - fresh.length + i; // new posts go to the top, newest first
      await addPost(known, record, sources);
      if (isNew) { added++; log(`  + ${record.code} ${record.type} ${record.takenAt.slice(0, 10)} ${record.caption.split('\n')[0].slice(0, 60)}`); }
    } catch (e) {
      if (e instanceof Blocked) throw e;
      console.warn(`  ! ${listed.shortcode}: ${e.message}`);
    }
    await sleep(1200);
  }
  for (const sm of media) {
    const p = known.get(sm.shortcode);
    if (p) known.set(sm.shortcode, { ...p, comments: sm.edge_media_to_comment?.count ?? p.comments });
  }

  // Rotating check: a slice of the archive every run, so each post is looked at
  // about once a day; posts deleted on Instagram are removed here.
  const removed = [];
  const listedCodes = new Set(media.map((m) => m.shortcode));
  const codes = [...known.keys()].filter((c) => !listedCodes.has(c)).sort();
  const slots = Math.max(1, Math.ceil(codes.length / ROTATION_SIZE));
  const slot = Math.floor(Date.now() / RUN_EVERY_MS) % slots;
  const batch = codes.slice(slot * ROTATION_SIZE, (slot + 1) * ROTATION_SIZE);
  log(`Checking ${batch.length} older posts (batch ${slot + 1}/${slots})…`);
  for (const code of batch) {
    const p = known.get(code);
    let st;
    try { st = await postStatus(code); } catch (e) {
      if (e instanceof Blocked) throw e;
      console.warn(`  ! ${code}: ${e.message}`);
      continue;
    }
    if (st.state === 'live') {
      const next = { ...p, comments: st.comments ?? p.comments, ...(p.type !== 'photo' ? { blocked: st.blocked } : {}) };
      delete next.missingSince;
      known.set(code, next);
    } else if (st.state === 'gone') {
      if (!p.missingSince) {
        known.set(code, { ...p, missingSince: new Date().toISOString() });
        log(`  ? ${code} looks deleted; will remove if it's still gone next time`);
      } else if (Date.now() - Date.parse(p.missingSince) >= REMOVE_AFTER_MS) {
        known.delete(code);
        if (validCode(code)) await rm(path.join(ROOT, MEDIA_DIR, code), { recursive: true, force: true });
        removed.push(code);
        log(`  - ${code} removed (deleted on Instagram)`);
      }
    }
    await sleep(1200);
  }
  return { added, removed, profile };
}

/* ── Names for the @handles the site shows ───────────────────────────── */
function handlesToName(db) {
  const out = new Set();
  const grab = (text) => { for (const m of (text || '').matchAll(/@([A-Za-z0-9._]{1,30})/g)) out.add(m[1].replace(/\.+$/, '')); };
  grab(db.profile?.bio);
  for (const p of db.posts) {
    grab(p.caption);
    if (p.owner) out.add(p.owner);
    p.coauthors?.forEach((h) => out.add(h));
  }
  out.delete(USERNAME);
  return [...out].filter(validHandle);
}
async function refreshNames(db) {
  db.people ||= {};
  const now = Date.now();
  const due = handlesToName(db).filter((h) => {
    const p = db.people[h];
    return !p || now - Date.parse(p.checkedAt) > NAME_TTL_DAYS * 864e5;
  }).slice(0, NAME_LOOKUPS_PER_RUN);
  if (due.length) log(`Looking up ${due.length} display name(s)…`);
  for (const h of due) {
    try {
      db.people[h] = { name: await lookupName(h), checkedAt: new Date().toISOString() };
    } catch (e) {
      if (e instanceof Blocked) { console.warn(`  ! names: ${e.message}`); break; }
      console.warn(`  ! @${h}: ${e.message}`);
    }
    await sleep(900);
  }
}

/* ── Main ────────────────────────────────────────────────────────────── */
async function main() {
  if (PROBE) {
    if (!PROBE.length || !PROBE.every(validCode)) throw new Error('--probe takes comma-separated post codes');
    for (const code of PROBE) log(`${code}: ${JSON.stringify(await postStatus(code))}`);
    return;
  }
  const db = existsSync(DATA_FILE)
    ? JSON.parse(await readFile(DATA_FILE, 'utf8'))
    : { username: USERNAME, profile: {}, highlights: [], people: {}, posts: [] };
  const snapshot = () => JSON.stringify([db.posts, db.profile, db.highlights, db.people]);
  const before = snapshot();
  const known = new Map(db.posts.map((p) => [p.code, p]));

  log(`Reading @${USERNAME}…`);
  let result;
  try {
    result = await syncViaProfile(db, known);
    db.mode = 'profile';
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    log(`Profile page blocked (${e.message}); using the public embeds.`);
    try {
      result = await syncViaEmbed(db, known);
      db.mode = 'embed';
    } catch (embedError) {
      if (!(embedError instanceof Blocked)) throw embedError;
      log(`Embed reads blocked too (${embedError.message}); keeping existing data for this run.`);
      result = { added: 0, removed: [], profile: db.profile || {} };
      db.mode = 'blocked';
    }
  }
  const { added, removed, profile } = result;

  // profile picture: a new file name means he changed it
  const { picUrl, ...facts } = profile;
  if (picUrl && (REFRESH_ALL || coverKey(picUrl) !== db.profile?.picKey || !existsSync(path.join(ROOT, MEDIA_DIR, '_profile.webp')))) {
    try {
      await saveSmallImage(picUrl, `${MEDIA_DIR}/_profile.webp`, 320);
      facts.pic = `${MEDIA_DIR}/_profile.webp`;
      facts.picKey = coverKey(picUrl);
    } catch (e) { console.warn(`  ! profile picture: ${e.message}`); }
  }
  db.username = USERNAME;
  db.profile = { ...db.profile, ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v != null)) };
  db.posts = [...known.values()].sort((a, b) => (a.gridIndex ?? 0) - (b.gridIndex ?? 0) || b.takenAt.localeCompare(a.takenAt));
  db.posts.forEach((p, i) => { p.gridIndex = i; });

  await refreshNames(db);

  const changed = snapshot() !== before;
  if (changed) {
    db.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(db, null, 1) + '\n');
  }
  log(changed ? `Saved: ${added} new, ${removed.length} removed, ${db.posts.length} total.` : 'No changes.');
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `added=${added}\nremoved=${removed.length}\nchanged=${changed}\n`, { flag: 'a' });
  }
}

main().catch((e) => {
  console.error(e instanceof Blocked ? `Instagram refused the request: ${e.message}` : e);
  process.exit(e instanceof Blocked ? 2 : 1);
});
