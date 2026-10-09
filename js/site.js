/* Afraz Ali — Edit Suite. No dependencies. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const mq = (q) => window.matchMedia(q).matches;
  const REDUCED = mq('(prefers-reduced-motion: reduce)');
  const SAVE_DATA = !!navigator.connection?.saveData;
  const CAN_HOVER = mq('(hover: hover) and (pointer: fine)');
  const FPS = 25;
  const SELF = 'afrxz.fx';
  const DM = `https://ig.me/m/${SELF}`;

  const pad = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
  const tc = (s) => (Number.isFinite(s) ? `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}:${pad((s % 1) * FPS)}` : '00:00:00:00');
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let data = { order: [], cuts: {} };
  try { data = JSON.parse($('#cuts')?.textContent || '{}'); } catch { /* the page still works as links */ }
  const cuts = data.cuts || {};
  const order = (data.order || []).filter((c) => cuts[c]);
  const totalRuntime = order.reduce((t, c) => t + cuts[c].m.reduce((a, m) => a + (m.v && m.d ? m.d : 0), 0), 0) || 600;

  /* ── previews: small muted loops ─────────────────────────────────── */
  const previewsOn = !REDUCED && !SAVE_DATA;
  const playing = new Set();
  const MAX_PLAYING = CAN_HOVER ? 3 : 2;

  function startPreview(media) {
    const v = $('video.pv', media);
    if (!v || !previewsOn) return;
    if (!v.src && v.dataset.src) v.src = v.dataset.src;
    playing.add(v);
    if (playing.size > MAX_PLAYING) {
      const oldest = playing.values().next().value;
      stopPreview(oldest.parentElement);
    }
    const p = v.play();
    if (p) p.then(() => media.classList.add('is-playing')).catch(() => {});
  }
  function stopPreview(media) {
    const v = $('video.pv', media);
    if (!v) return;
    playing.delete(v);
    v.pause();
    media.classList.remove('is-playing');
  }

  if (previewsOn) {
    // Hover to preview (mouse); big client cards also play when mostly in view.
    if (CAN_HOVER) {
      for (const link of $$('.clip-link, .cut-link')) {
        const media = $('.media', link);
        link.addEventListener('pointerenter', () => startPreview(media));
        link.addEventListener('pointerleave', () => stopPreview(media));
        link.addEventListener('focus', () => startPreview(media));
        link.addEventListener('blur', () => stopPreview(media));
      }
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const media = e.target;
        if (e.isIntersecting && e.intersectionRatio >= 0.7) startPreview(media);
        else stopPreview(media);
      }
    }, { threshold: [0, 0.7] });
    $$('.cut .media').forEach((m) => io.observe(m));
    if (!CAN_HOVER) $$('.clip .media').forEach((m) => io.observe(m));
  }

  /* ── hero monitor: timecode + level meters ───────────────────────── */
  const heroVideo = $('.hero-video');
  const monTc = $('.mon-tc');
  const meters = $$('.meters i');
  if (heroVideo) {
    if (REDUCED || SAVE_DATA) {
      heroVideo.removeAttribute('autoplay');
      heroVideo.preload = 'none';
      heroVideo.pause();
    } else {
      const live = () => heroVideo.classList.add('is-live');
      heroVideo.addEventListener('playing', live);
      if (heroVideo.readyState >= 3 && !heroVideo.paused) live();
      heroVideo.play()?.catch(() => {});
    }
    let heroVisible = true;
    new IntersectionObserver(([e]) => {
      heroVisible = e.isIntersecting;
      if (REDUCED || SAVE_DATA) return;
      if (heroVisible) heroVideo.play()?.catch(() => {});
      else heroVideo.pause();
    }).observe(heroVideo);
    let t = 0;
    const tick = (now) => {
      if (heroVisible) {
        if (monTc) monTc.textContent = tc(heroVideo.currentTime || 0);
        if (meters.length && !heroVideo.paused && now - t > 90) {
          t = now;
          meters.forEach((m, i) => m.style.setProperty('--lvl', `${38 + Math.random() * 46 + (i ? -6 : 0)}%`));
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ── page timeline, header timecode, section highlight ───────────── */
  const timeline = $('.timeline');
  const track = $('.tl-track');
  const head = $('.tl-head');
  const tcVal = $('.tc-val');
  const tabs = $$('.tabs a');
  const SECTIONS = [
    ['top', 'Reel', 'var(--rec)'],
    ['work', 'Client work', 'var(--y2025)'],
    ['edits', 'Edits', 'var(--y2026)'],
    ['stories', 'Stories', 'var(--y2024)'],
    ['about', 'About', 'var(--y2023)'],
    ['contact', 'Export', 'var(--y2022)'],
  ].map(([id, label, color]) => ({ id, label, color, node: document.getElementById(id) })).filter((s) => s.node);

  const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  function layoutTimeline() {
    if (!track) return;
    track.textContent = '';
    const total = document.documentElement.scrollHeight;
    SECTIONS.forEach((s, i) => {
      const top = i === 0 ? 0 : s.node.getBoundingClientRect().top + scrollY;
      const next = SECTIONS[i + 1];
      const end = next ? next.node.getBoundingClientRect().top + scrollY : total;
      const a = el('a', 'tl-clip');
      a.href = `#${s.id}`;
      a.style.left = `calc(${(top / total) * 100}% + 2px)`;
      a.style.width = `calc(${((end - top) / total) * 100}% - 4px)`;
      a.style.setProperty('--c', s.color);
      a.setAttribute('aria-label', s.label);
      a.append(el('span', null, s.label));
      track.append(a);
    });
  }
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const f = Math.min(1, Math.max(0, scrollY / maxScroll()));
      if (head) head.style.transform = `translateX(${f * timeline.clientWidth}px)`;
      if (tcVal) tcVal.textContent = tc(f * totalRuntime);
      let here = null;
      for (const s of SECTIONS) if (s.node.getBoundingClientRect().top < innerHeight * 0.4) here = s.id;
      tabs.forEach((a) => a.classList.toggle('is-here', a.getAttribute('href') === `#${here}`));
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { layoutTimeline(); onScroll(); });
  new ResizeObserver(() => { layoutTimeline(); onScroll(); }).observe(document.body);
  layoutTimeline();
  onScroll();

  if (timeline) {
    let drag = false;
    const seek = (x, smooth) => {
      const f = Math.min(1, Math.max(0, x / timeline.clientWidth));
      scrollTo({ top: f * maxScroll(), behavior: smooth && !REDUCED ? 'smooth' : 'instant' });
    };
    timeline.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tl-clip') && e.pointerType === 'mouse' && e.detail > 1) return;
      drag = true;
      timeline.setPointerCapture(e.pointerId);
      seek(e.clientX, false);
      e.preventDefault();
    });
    timeline.addEventListener('pointermove', (e) => { if (drag) seek(e.clientX, false); });
    const end = () => { drag = false; };
    timeline.addEventListener('pointerup', end);
    timeline.addEventListener('pointercancel', end);
    timeline.addEventListener('click', (e) => { if (e.target.closest('.tl-clip')) e.preventDefault(); });
  }

  /* ── client work rail ────────────────────────────────────────────── */
  const rail = $('.cuts');
  const railBar = $('.rail-bar span');
  const railBtns = $$('[data-rail]');
  if (rail) {
    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth;
      const f = max > 0 ? rail.scrollLeft / max : 0;
      const w = rail.scrollWidth ? rail.clientWidth / rail.scrollWidth : 1;
      if (railBar) {
        railBar.style.width = `${Math.min(100, w * 100)}%`;
        railBar.style.transform = `translateX(${f * (1 / Math.max(w, 0.0001) - 1) * 100}%)`;
      }
      railBtns.forEach((b) => { b.disabled = +b.dataset.rail < 0 ? rail.scrollLeft < 8 : rail.scrollLeft > max - 8; });
    };
    rail.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    update();
    railBtns.forEach((b) => b.addEventListener('click', () => {
      rail.scrollBy({ left: +b.dataset.rail * rail.clientWidth * 0.8, behavior: REDUCED ? 'instant' : 'smooth' });
    }));
    // drag to scroll with a mouse
    let down = null;
    rail.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = { x: e.clientX, left: rail.scrollLeft, moved: false };
    });
    addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (Math.abs(dx) > 6) { down.moved = true; rail.style.scrollSnapType = 'none'; rail.scrollLeft = down.left - dx; }
    });
    addEventListener('pointerup', () => {
      if (down?.moved) {
        rail.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
        rail.style.scrollSnapType = '';
      }
      down = null;
    });
  }

  /* ── edit bay: year bins + "show all" ────────────────────────────── */
  const clips = $$('.clips .clip');
  const bins = $$('.bin');
  const more = $('.more');
  const limit = +($('.clips')?.dataset.limit || 18);
  let bin = 'all';
  let expanded = false;
  function applyBins() {
    let shown = 0;
    for (const c of clips) {
      const match = bin === 'all' || c.dataset.year === bin;
      const show = match && (expanded || bin !== 'all' || shown < limit);
      c.hidden = !show;
      if (show) shown++;
    }
    if (more) more.parentElement.hidden = expanded || bin !== 'all';
    bins.forEach((b) => {
      const on = b.dataset.bin === bin;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  bins.forEach((b) => b.addEventListener('click', () => { bin = b.dataset.bin; applyBins(); }));
  more?.addEventListener('click', () => {
    expanded = true;
    applyBins();
    clips.find((c) => !c.hidden && clips.indexOf(c) >= limit)?.querySelector('a')?.focus({ preventScroll: true });
  });
  applyBins();

  /* ── the viewer ──────────────────────────────────────────────────── */
  const dlg = $('.viewer');
  const stage = $('.v-stage');
  const vTitle = $('.v-title');
  const vSub = $('.v-sub');
  const vKind = $('.v-kind');
  const vIdx = $('.v-idx');
  const vClips = $('.v-clips');
  const vDesc = $('.v-desc');
  const vCast = $('.v-cast');
  const vIg = $('.v-ig');
  const ctrl = $('.v-ctrl');
  const vTc = $('.v-tc');
  const vDur = $('.v-dur');
  const scrub = $('.v-scrub');
  const fill = $('.v-fill');
  const buf = $('.v-buf');
  const knob = $('.v-knob');
  const playBtn = $('.v-play');
  const muteBtn = $('.v-mute');
  const fullBtn = $('.v-full');
  let current = null;   // post code
  let clipIdx = 0;
  let video = null;
  let raf = 0;
  let muted = false;

  function paintTime() {
    if (!video) return;
    const d = video.duration || 0;
    const t = video.currentTime || 0;
    const f = d ? t / d : 0;
    vTc.textContent = tc(t);
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
    scrub.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    scrub.setAttribute('aria-valuetext', tc(t));
    if (video.buffered.length) buf.style.width = `${(video.buffered.end(video.buffered.length - 1) / (d || 1)) * 100}%`;
  }
  function loop() {
    paintTime();
    raf = video && !video.paused ? requestAnimationFrame(loop) : 0;
  }

  function fallbackToInstagram(code, note) {
    stage.textContent = '';
    stage.classList.remove('is-loading');
    const f = document.createElement('iframe');
    f.src = `https://www.instagram.com/p/${encodeURIComponent(code)}/embed/`;
    f.title = 'Instagram player';
    f.loading = 'lazy';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    stage.append(f);
    if (note) stage.append(el('p', 'v-note', note));
    ctrl.classList.add('is-off');
    video = null;
  }

  function mountClip(i) {
    const cut = cuts[current];
    const m = cut.m[i];
    clipIdx = i;
    cancelAnimationFrame(raf);
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    video = null;
    stage.textContent = '';
    $$('.v-clip', vClips).forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
    if (!m.v) {
      const img = el('img');
      img.src = m.s;
      img.width = m.w;
      img.height = m.h;
      img.alt = cut.t;
      stage.append(img);
      ctrl.classList.add('is-off');
      dlg.classList.remove('is-playing');
      return;
    }
    if (cut.x) {
      // Licensed music: Instagram only plays this one in its own app/site.
      const loopV = document.createElement('video');
      loopV.muted = true;
      loopV.loop = true;
      loopV.playsInline = true;
      loopV.poster = m.s;
      loopV.width = m.w;
      loopV.height = m.h;
      if (m.p && !REDUCED) { loopV.src = m.p; loopV.autoplay = true; }
      const box = el('div', 'v-blocked');
      box.append(el('p', null, 'This cut uses licensed music, so the full version with sound plays on Instagram.'));
      const a = el('a', 'btn btn--rec', 'Watch on Instagram ↗');
      a.href = `https://www.instagram.com/p/${encodeURIComponent(current)}/`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.append(a);
      stage.append(loopV, box);
      loopV.play?.()?.catch(() => {});
      ctrl.classList.add('is-off');
      dlg.classList.remove('is-playing');
      return;
    }
    ctrl.classList.remove('is-off');
    stage.classList.add('is-loading');
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.poster = m.s;
    v.width = m.w;
    v.height = m.h;
    v.muted = muted;
    v.setAttribute('disablepictureinpicture', '');
    v.src = `/api/clip?c=${encodeURIComponent(current)}&i=${i + 1}`;
    video = v;
    vDur.textContent = tc(m.d || 0);
    v.addEventListener('loadedmetadata', () => { vDur.textContent = tc(v.duration); paintTime(); });
    v.addEventListener('canplay', () => stage.classList.remove('is-loading'));
    v.addEventListener('waiting', () => stage.classList.add('is-loading'));
    v.addEventListener('playing', () => { stage.classList.remove('is-loading'); dlg.classList.add('is-playing'); loop(); });
    v.addEventListener('pause', () => { dlg.classList.remove('is-playing'); paintTime(); });
    v.addEventListener('ended', () => {
      dlg.classList.remove('is-playing');
      if (clipIdx < cut.m.length - 1) mountClip(clipIdx + 1);
    });
    v.addEventListener('progress', paintTime);
    v.addEventListener('volumechange', () => { muted = v.muted; dlg.classList.toggle('is-muted', v.muted); });
    v.addEventListener('click', togglePlay);
    v.addEventListener('error', () => {
      if (video !== v) return;
      fallbackToInstagram(current, 'Playing through Instagram');
    });
    stage.append(v);
    paintTime();
    const p = v.play();
    if (p) p.catch((err) => {
      if (err?.name === 'NotAllowedError' && !v.muted) { v.muted = true; v.play().catch(() => {}); }
    });
  }

  function fill_info(code) {
    const cut = cuts[code];
    const i = order.indexOf(code);
    vKind.textContent = cut.k;
    vIdx.textContent = `${pad(i + 1)} / ${pad(order.length)}`;
    vTitle.textContent = cut.t;
    vSub.textContent = '';
    for (const bit of [cut.d, cut.o ? `with ${cut.o}` : null, cut.mu ? `♪ ${cut.mu}` : null, cut.m.length > 1 ? `${cut.m.length} clips` : null].filter(Boolean)) vSub.append(el('span', null, bit));
    vClips.textContent = '';
    if (cut.m.length > 1) {
      cut.m.forEach((m, j) => {
        const b = el('button', 'v-clip', `${m.v ? 'Clip' : 'Still'} ${pad(j + 1)}`);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.addEventListener('click', () => mountClip(j));
        vClips.append(b);
      });
    }
    vDesc.textContent = '';
    for (const p of cut.b || []) vDesc.append(el('p', null, p));
    vCast.textContent = '';
    const people = cut.f || [];
    if (people.length || (cut.c || []).length) {
      if (people.length) {
        vCast.append(el('h3', null, 'Featuring'));
        vCast.append(el('p', null, people.join(' · ')));
      }
      if ((cut.c || []).length) {
        vCast.append(el('h3', null, 'Credits'));
        for (const c of cut.c) vCast.append(el('p', null, c));
      }
    }
    vIg.href = `https://www.instagram.com/p/${encodeURIComponent(code)}/`;
    vIg.hidden = !!cut.x; // licensed-music cuts already show a "Watch on Instagram" button
  }

  let returnFocus = null;
  function open(code, { push = true, clip = 0 } = {}) {
    if (!cuts[code] || !dlg) return false;
    if (!dlg.open) {
      returnFocus = document.activeElement;
      dlg.showModal();
      stage.focus({ preventScroll: true });
      document.documentElement.style.overflow = 'hidden';
      playing.forEach((v) => stopPreview(v.parentElement));
      heroVideo?.pause();
    }
    current = code;
    fill_info(code);
    mountClip(clip);
    const hash = `#cut/${code}`;
    if (push && location.hash !== hash) history.pushState({ cut: code }, '', hash);
    else if (!push) history.replaceState({ cut: code }, '', hash);
    return true;
  }
  function reallyClose() {
    cancelAnimationFrame(raf);
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    video = null;
    stage.textContent = '';
    current = null;
    dlg.classList.remove('is-playing');
    if (dlg.open) dlg.close();
    document.documentElement.style.overflow = '';
    if (!REDUCED && !SAVE_DATA) heroVideo?.play()?.catch(() => {});
    returnFocus?.focus?.({ preventScroll: true });
  }
  function close() {
    if (history.state?.cut) history.back();   // popstate closes it
    else {
      history.replaceState(null, '', location.pathname + location.search);
      reallyClose();
    }
  }
  function step(dir) {
    if (!current) return;
    const i = order.indexOf(current);
    const next = order[(i + dir + order.length) % order.length];
    open(next, { push: false });
  }
  function togglePlay() {
    if (!video) return;
    if (video.paused) { video.playbackRate = 1; video.play().catch(() => {}); } else video.pause();
  }
  function seekBy(s) { if (video) { video.currentTime = Math.min(Math.max(0, video.currentTime + s), video.duration || 0); paintTime(); } }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (open(a.dataset.open)) e.preventDefault();
  });
  addEventListener('popstate', () => {
    const m = location.hash.match(/^#cut\/([A-Za-z0-9_-]+)$/);
    if (m && cuts[m[1]]) open(m[1], { push: false });
    else if (dlg?.open) reallyClose();
  });
  if (dlg) {
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    $('[data-v="close"]', dlg)?.addEventListener('click', close);
    $('[data-v="prev"]', dlg)?.addEventListener('click', () => step(-1));
    $('[data-v="next"]', dlg)?.addEventListener('click', () => step(1));
    playBtn.addEventListener('click', togglePlay);
    muteBtn.addEventListener('click', () => { if (video) video.muted = !video.muted; });
    fullBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (video?.requestFullscreen) video.requestFullscreen().catch(() => {});
      else video?.webkitEnterFullscreen?.();
    });
    // scrubbing
    let scrubbing = false;
    const scrubTo = (x) => {
      if (!video?.duration) return;
      const r = scrub.getBoundingClientRect();
      video.currentTime = Math.min(1, Math.max(0, (x - r.left) / r.width)) * video.duration;
      paintTime();
    };
    scrub.addEventListener('pointerdown', (e) => { scrubbing = true; scrub.setPointerCapture(e.pointerId); scrubTo(e.clientX); });
    scrub.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e.clientX); });
    scrub.addEventListener('pointerup', () => { scrubbing = false; });
    scrub.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(e.key === 'ArrowLeft' ? -1 : 1); }
    });
    // editor's shortcuts: J K L shuttle, , . frame step
    dlg.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ' && e.target.closest('button, a')) return;
      if (k === ' ' || k === 'k') { e.preventDefault(); if (k === 'k' && video && !video.paused) { video.pause(); video.playbackRate = 1; } else togglePlay(); }
      else if (k === 'l') {
        e.preventDefault();
        if (!video) return;
        if (video.paused) video.play().catch(() => {});
        else video.playbackRate = Math.min(4, video.playbackRate * 2);
      } else if (k === 'j') { e.preventDefault(); seekBy(-5); }
      else if (k === ',' || k === '.') { e.preventDefault(); if (video) { video.pause(); seekBy(k === ',' ? -1 / FPS : 1 / FPS); } }
      else if (k === 'm') { e.preventDefault(); if (video) video.muted = !video.muted; }
      else if (k === 'f') { e.preventDefault(); fullBtn.click(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });
    // swipe between cuts on touch
    let sx = null;
    stage.addEventListener('touchstart', (e) => { sx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 70) step(dx < 0 ? 1 : -1);
      sx = null;
    }, { passive: true });
  }
  const initial = location.hash.match(/^#cut\/([A-Za-z0-9_-]+)$/);
  if (initial && cuts[initial[1]]) open(initial[1], { push: false });

  /* ── brief → clipboard → DM ──────────────────────────────────────── */
  const form = $('#brief');
  const status = $('.brief-status');
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* older browsers */ }
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const name = String(f.get('name') || '').trim();
    if (!name) {
      status.textContent = 'Add your name so he knows who it’s from.';
      form.elements.name.focus();
      return;
    }
    const lines = [
      `Hi Afraz! A brief from ${name}${f.get('project') ? ` (${String(f.get('project')).trim()})` : ''}:`,
      `• Cut: ${f.get('type')}`,
      `• Timeline: ${f.get('when')}`,
    ];
    const idea = String(f.get('idea') || '').trim();
    if (idea) lines.push(`• Idea: ${idea}`);
    lines.push('', '— sent from your portfolio');
    const ok = await copy(lines.join('\n'));
    const win = window.open(DM, '_blank', 'noopener');
    status.textContent = '';
    if (ok) status.append(document.createTextNode('Brief copied. Paste it into the chat that just opened.'));
    else status.append(document.createTextNode('Couldn’t copy automatically. Select your text above and send it in his DMs.'));
    if (!win) {
      status.append(document.createTextNode(' '));
      const a = el('a', null, 'Open his DMs');
      a.href = DM;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      status.append(a);
    }
  });
})();
