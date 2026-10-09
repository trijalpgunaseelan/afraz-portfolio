/*
 * GET /api/clip?c=<post code>&i=<clip number>
 *
 * Redirects the site's video player to the full-quality file (with sound) on
 * Instagram's CDN. Instagram signs those links for about a day and a half, so
 * a fresh one is read from the post's public embed. Vercel's CDN caches each
 * redirect for 4 hours, so Instagram sees a handful of requests a day.
 *
 * Only posts that are on the page (api/_clips.json, written by the build) are
 * served, and only to Instagram's own video hosts.
 */
'use strict';
const https = require('node:https');
const zlib = require('node:zlib');
const clips = require('./_clips.json');

const CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;
const VIDEO_HOST_RE = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CACHE_OK = 'public, max-age=0, s-maxage=14400, stale-while-revalidate=1800';

// Small per-instance rate limit; the CDN cache absorbs normal traffic.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
  h.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  return h.n > MAX_PER_WINDOW;
}

function embedHtml(code) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://www.instagram.com/p/${code}/embed/captioned/`, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip',
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        referer: 'https://afrazali.vercel.app/',
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`instagram ${res.statusCode}`)); return; }
      const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      let size = 0;
      body.on('data', (c) => { size += c.length; if (size > 3e6) req.destroy(new Error('too large')); else chunks.push(c); });
      body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      body.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

async function videoUrl(code, i) {
  const html = await embedHtml(code);
  const raw = html.match(/"contextJSON":"((?:[^"\\]|\\.)*)"/)?.[1];
  if (!raw) throw new Error('no embed data');
  const sm = JSON.parse(JSON.parse(`"${raw}"`))?.gql_data?.shortcode_media;
  if (!sm || sm.shortcode !== code) throw new Error('embed did not match');
  const items = sm.edge_sidecar_to_children?.edges?.map((e) => e.node) || [sm];
  const url = items[i - 1]?.video_url;
  if (typeof url !== 'string') throw new Error('no video');
  const u = new URL(url);
  if (u.protocol !== 'https:' || !VIDEO_HOST_RE.test(u.hostname)) throw new Error('unexpected host');
  return u.href;
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end();
  }
  const code = String(req.query?.c || '');
  const i = Number.parseInt(String(req.query?.i || '1'), 10);
  if (!CODE_RE.test(code) || !Object.hasOwn(clips, code) || !clips[code].includes(i)) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    res.statusCode = 404;
    return res.end();
  }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) {
    res.setHeader('Retry-After', '60');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 429;
    return res.end();
  }
  try {
    const url = await videoUrl(code, i);
    res.setHeader('Cache-Control', CACHE_OK);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.statusCode = 302;
    res.setHeader('Location', url);
    return res.end();
  } catch (e) {
    console.warn(`clip ${code}/${i}: ${e.message}`);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 502;
    return res.end();
  }
};
