/* ============================================================
   Little Super Claws — app.js
   Brings the living world to life (no build step required)
   ============================================================ */
(function () {
  'use strict';
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- Data ---------- */
  const FEATURES = [
    { i: '🗺️', t: 'Explore a splatted Dublin', d: 'Walk a photoreal 3D city built from Gaussian Splats — never the same twice.' },
    { i: '📍', t: 'Type any location', d: 'Temple Bar, Grafton Street, Croke Park… name it and drop straight in.' },
    { i: '✨', t: 'Generate magical scenes', d: 'Agents conjure a fresh Superclaws scene around your location in seconds.' },
    { i: '🐾', t: 'Find the crew', d: 'The Claws are hidden across the city. Discover them and interact.' },
    { i: '🤳', t: 'Join the lineup', d: 'Upload your photo and stand shoulder-to-claw with the crew.' },
    { i: '💬', t: 'Talk to a Superclaw', d: 'Live conversational character agents with real voices.' },
    { i: '🎟️', t: 'Real treasure hunts', d: 'Scan QR codes on hidden figures to unlock clues and prizes.' },
    { i: '📤', t: 'Share the magic', d: 'One tap to WhatsApp, Email or download — every scene saved to your gallery.' },
  ];

  const CREW = [
    { img: 'claw-orange.jpg', name: 'Clawd',   power: 'Mega Pinch',   color: '#ea6233', bio: 'The fearless leader — loud, brave… and slightly startled by absolutely everything.' },
    { img: 'claw-blue.jpg',   name: 'Decklan', power: 'Gadget Claws', color: '#3f7fd0', bio: 'Builds wild gadgets from whatever he finds on the cobbles.' },
    { img: 'claw-purple.jpg', name: 'Deirdre', power: 'Giant Hug',    color: '#7c5ce0', bio: 'The biggest claws in the crew — and by far the softest heart.' },
    { img: 'claw-green.jpg',  name: 'Gerald',  power: 'Speed Splat',  color: '#4caf67', bio: 'Zooms across the city before the world finishes rendering.' },
    { img: 'claw-yellow.jpg', name: 'Nessa',   power: 'Star Beam',    color: '#e8a31f', bio: 'Lights up the darkest Dublin laneway with a giant grin.' },
  ];

  const AGENTS = [
    { i: '🏗️', n: 'Scene Builder',      s: 'Generating 3D scenes' },
    { i: '🧭', n: 'Location Scout',     s: 'Resolving Dublin spots' },
    { i: '💠', n: 'Splat Generator',    s: 'Rendering Gaussian splats' },
    { i: '🎙️', n: 'Voice Agent',        s: 'Bringing the cast to life' },
    { i: '🌗', n: 'Day / Night Agent',  s: 'Tuning the world to local time' },
    { i: '🌀', n: 'World Orchestrator', s: 'Refreshing the whole world' },
  ];

  const REQUESTS = [
    { p: "Ha'penny Bridge", t: 'just now' },
    { p: 'Phoenix Park',    t: '1 min ago' },
    { p: 'Dublin Castle',   t: '2 min ago' },
    { p: 'The Spire',       t: '4 min ago' },
    { p: 'Merrion Square',  t: '6 min ago' },
    { p: 'Camden Street',   t: '8 min ago' },
  ];

  /* ---------- Render: features ---------- */
  const fg = $('#featureGrid');
  FEATURES.forEach((f, idx) => {
    const el = document.createElement('div');
    el.className = 'fcard reveal';
    el.style.transitionDelay = (idx % 4) * 60 + 'ms';
    el.innerHTML = `<span class="fnum">${idx + 1}</span>
      <div class="ficon">${f.i}</div><h3>${f.t}</h3><p>${f.d}</p>`;
    fg.appendChild(el);
  });

  /* ---------- Render: crew ---------- */
  const cg = $('#crewGrid');
  CREW.forEach((c, idx) => {
    const el = document.createElement('div');
    el.className = 'crew-card reveal';
    el.style.transitionDelay = idx * 70 + 'ms';
    el.innerHTML = `
      <div class="crew-photo"><img src="assets/${c.img}" alt="${c.name}, a Little Super Claw"></div>
      <div class="crew-body">
        <h3>${c.name}</h3>
        <span class="crew-power" style="background:${c.color}">${c.power}</span>
        <p>${c.bio}</p>
      </div>`;
    cg.appendChild(el);
  });

  /* ---------- Render: agents + requests ---------- */
  const al = $('#agentList');
  AGENTS.forEach(a => {
    const el = document.createElement('div');
    el.className = 'arow';
    el.innerHTML = `<span class="ad">${a.i}</span>
      <span><b>${a.n}</b><small>${a.s}</small></span>
      <span class="stat"><i></i> Live</span>`;
    al.appendChild(el);
  });
  const rl = $('#reqList');
  function renderReqs() {
    rl.innerHTML = '';
    REQUESTS.forEach(r => {
      const el = document.createElement('div');
      el.className = 'rrow';
      el.innerHTML = `<span class="rpin">📍</span><b>${r.p}</b><span class="rtime">${r.t}</span>`;
      rl.appendChild(el);
    });
  }
  renderReqs();

  /* ---------- Render: QR (decorative, deterministic) ---------- */
  const qr = $('#qrGrid');
  if (qr) {
    // fixed pattern so it looks like a real QR (finder squares + body)
    const N = 11;
    const finder = (r, c) => (r < 3 && c < 3) || (r < 3 && c > N - 4) || (r > N - 4 && c < 3);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const cell = document.createElement('i');
      const on = finder(r, c)
        ? !((r === 1 || r === N - 2) && c > 0 && c < N - 1) &&
          !((c === 1 || c === N - 2) && r > 0 && r < N - 1) // hollow-ish finders
        : rnd() > 0.48;
      cell.style.background = on ? '#14121f' : 'transparent';
      qr.appendChild(cell);
    }
  }

  /* ---------- Day / Night mode ---------- */
  const html = document.documentElement;
  function setMode(mode) {
    html.setAttribute('data-mode', mode);
    $$('#modeToggle button, .mini-modes button').forEach(b =>
      b.classList.toggle('is-active', b.dataset.mode === mode));
    if (mode === 'rain') buildRain();
    if (window.__lscSetWorldMode) window.__lscSetWorldMode(mode); // drive the WebGL city
  }
  window.__lscSetMode = setMode; // let the WebGL module read/restore the current mode
  $$('#modeToggle button[data-mode], .mini-modes button[data-mode]').forEach(b =>
    b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#spawnCrewBtn').addEventListener('click', () =>
    window.__lscViewer?.spawnCrewHere?.());

  // mode: ?mode=day|evening|night|rain wins; else auto time-of-day on first load
  const forced = new URLSearchParams(location.search).get('mode');
  if (['day', 'evening', 'night', 'rain'].includes(forced)) {
    setMode(forced);
  } else {
    const hr = new Date().getHours();
    setMode(hr >= 21 || hr < 6 ? 'night' : hr >= 17 ? 'evening' : 'day');
  }

  /* ---------- Rain layer ---------- */
  let rainBuilt = false;
  function buildRain() {
    if (rainBuilt) return;
    const layer = document.createElement('div');
    layer.className = 'rain-layer';
    let html2 = '';
    for (let i = 0; i < 90; i++) {
      const left = (i * 37) % 100;
      const dur = 0.6 + (i % 7) * 0.12;
      const delay = (i % 11) * 0.18;
      html2 += `<i style="left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s;opacity:${0.3 + (i % 5) * 0.12}"></i>`;
    }
    layer.innerHTML = html2;
    document.body.appendChild(layer);
    rainBuilt = true;
  }

  /* ---------- Hero agent badge cycle ---------- */
  const abTitle = $('#abTitle'), abStatus = $('#abStatus');
  let ai = 0;
  setInterval(() => {
    ai = (ai + 1) % AGENTS.length;
    abTitle.style.opacity = 0; abStatus.style.opacity = 0;
    setTimeout(() => {
      abTitle.textContent = AGENTS[ai].n;
      abStatus.textContent = AGENTS[ai].s + '…';
      abTitle.style.opacity = 1; abStatus.style.opacity = 1;
    }, 250);
  }, 2600);
  [abTitle, abStatus].forEach(e => e.style.transition = 'opacity .25s');

  /* ---------- Live request rotation ---------- */
  const moreLocs = ['Trinity College', 'Smithfield', 'Portobello', 'Dún Laoghaire Pier',
    'Howth Cliffs', 'Stephen\'s Green', 'George\'s Street Arcade', 'Christ Church'];
  let ml = 0;
  setInterval(() => {
    REQUESTS.pop();
    REQUESTS.unshift({ p: moreLocs[ml % moreLocs.length], t: 'just now' });
    REQUESTS.forEach((r, i) => { if (i > 0) r.t = ['1 min ago','2 min ago','4 min ago','6 min ago','8 min ago'][i-1] || '9 min ago'; });
    ml++;
    renderReqs();
    rl.firstChild.animate(
      [{ background: 'rgba(124,92,224,.18)' }, { background: 'var(--card-2)' }],
      { duration: 1400, easing: 'ease-out' });
  }, 4200);

  /* ---------- Search → scene generation ---------- */
  const form = $('#searchForm'), input = $('#searchInput');
  const modal = $('#sceneModal'), smStage = $('#smStage'), smLog = $('#smLog'),
        smLoc = $('#smLoc'), smActions = $('#smActions'), smImg = $('#smImg');
  const SCENES = ['assets/scene-explore.png', 'assets/scene-magic.png', 'assets/crew-lineup.jpg', 'assets/scene-pub.png'];
  let sceneIdx = 0;

  /* -- modal log helpers -- */
  let genToken = 0; // invalidates an in-flight run when a new one starts / modal closes
  const portal = $('.sm-portal');
  function openModalShell(loc) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    modal.querySelector('.sm-card').classList.remove('world-open');
    smStage.classList.remove('revealed');
    smActions.hidden = true;
    smLoc.textContent = loc;
    smLog.innerHTML = '';
    portal.style.setProperty('--r', '0%');
    window.__lscViewer && window.__lscViewer.closeModal();
  }
  function addStep(html, spinning = true) {
    const row = document.createElement('div');
    row.className = 'lg';
    row.innerHTML = `<span class="${spinning ? 'spin' : 'check'}">${spinning ? '' : '✓'}</span><span>${html}</span>`;
    smLog.appendChild(row);
    requestAnimationFrame(() => row.classList.add('show'));
    return row;
  }
  function tickStep(row) { const s = row.querySelector('.spin'); if (s) s.outerHTML = '<span class="check">✓</span>'; }
  function setStepText(row, html) { row.lastElementChild.innerHTML = html; }
  function setPortal(frac) { portal.style.setProperty('--r', Math.round(frac * 75) + '%'); }
  function finishScene(loc) {
    smStage.classList.add('revealed');
    addStep(`<b>Scene ready</b> — ${loc} is now in your gallery`, false);
    smActions.hidden = false;
    REQUESTS.pop(); REQUESTS.unshift({ p: loc, t: 'just now' }); renderReqs();
  }

  /* -- the real thing: World Labs Marble + Spark viewer -- */
  async function generateReal(loc, token) {
    const wl = window.LSC_WL, viewer = window.__lscViewer;
    const alive = () => token === genToken;

    const scout = addStep(`🧭 <b>Location Scout</b> resolving “${loc}”`);
    const resolved = wl.resolveWorldId(loc);
    let world;

    if (resolved) {
      tickStep(scout);
      const fetchRow = addStep(`💠 <b>Splat Generator</b> fetching the ${resolved.pregenerated ? 'pregenerated' : 'cached'} Marble world`);
      setPortal(0.25);
      world = await wl.getWorld(resolved.worldId);
      if (!alive()) return;
      tickStep(fetchRow);
    } else {
      tickStep(scout);
      const genRow = addStep(`🌀 <b>World Orchestrator</b> — new territory! Marble is building “${loc}” for real (~5 min). Leave this open or come back; it’ll be cached.`);
      world = await wl.generateWorld(loc, (phase, detail) => {
        if (!alive()) return;
        if (phase === 'progress') setStepText(genRow, `🌀 <b>World Orchestrator</b> building “${loc}” — ${detail}`);
        setPortal(Math.min(0.5, 0.1 + (parseFloat(detail) || 0) / 12));
      });
      if (!alive()) return;
      setStepText(genRow, `🌀 <b>World Orchestrator</b> built a brand-new world for “${loc}”`);
      tickStep(genRow);
    }

    // poster: real thumbnail while splats stream in
    const thumb = world.assets && world.assets.thumbnail_url;
    if (thumb) { smImg.src = thumb; smStage.classList.add('revealed'); }
    setPortal(0.6);

    const streamRow = addStep(`💠 <b>Splat Generator</b> streaming Gaussian splats… 0%`);
    const stream = () => viewer.openWorld(world, loc, f => {
      if (alive()) { setStepText(streamRow, `💠 <b>Splat Generator</b> streaming Gaussian splats… ${Math.round(f * 100)}%`); setPortal(0.6 + f * 0.4); }
    });
    try { await stream(); }
    catch (e) { // transient network blips mid-download are common — one retry
      if (!alive()) return;
      setStepText(streamRow, `💠 <b>Splat Generator</b> connection blip — retrying…`);
      await new Promise(t => setTimeout(t, 1200));
      await stream();
    }
    if (!alive()) { viewer.closeModal(); return; }
    tickStep(streamRow);
    modal.querySelector('.sm-card').classList.add('world-open');

    const crewRow = addStep(`🏗️ <b>Scene Builder</b> placing Clawd, Decklan, Deirdre, Gerald &amp; Nessa`);
    setTimeout(() => tickStep(crewRow), 1200);
    finishScene(loc);

    // also swap the big #explore section over to this world (splats come
    // from HTTP cache, so this is cheap) — close the modal and you're there
    if (viewer.showInExplore) {
      viewer.showInExplore(world, loc).then(ok => {
        if (ok && alive()) addStep(`🗺️ <b>World Orchestrator</b> — ${loc} is now live in the Explore section below`, false);
      });
    }
  }

  /* -- fallback: the original simulated reveal (offline / API down) -- */
  function generateSimulated(loc) {
    smImg.src = SCENES[sceneIdx++ % SCENES.length];
    const steps = [
      ['🧭', `<b>Location Scout</b> resolving “${loc}”`],
      ['💠', `<b>Splat Generator</b> rendering the Dublin splat`],
      ['🏗️', `<b>Scene Builder</b> placing the Super Claws`],
      ['🌗', `<b>Day/Night Agent</b> matching local light`],
      ['🎙️', `<b>Voice Agent</b> waking the crew`],
    ];
    let i = 0;
    (function next() {
      if (i > 0) tickStep(smLog.children[i - 1]);
      if (i < steps.length) {
        const [ic, txt] = steps[i];
        addStep(`${ic} ${txt}`);
        setPortal((i + 1) / steps.length);
        i++;
        setTimeout(next, 720);
      } else {
        finishScene(loc);
      }
    })();
  }

  /* The Spark viewer is an ES module loading from a CDN — on a cold cache it
     can land a few seconds after first interaction, so wait briefly for it. */
  function waitForViewer(ms = 12000) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function poll() {
        if (window.__lscViewer) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
  }

  function generate(loc) {
    loc = (loc || '').trim() || 'a secret Dublin laneway';
    const token = ++genToken;
    openModalShell(loc);
    if (!window.LSC_WL) return generateSimulated(loc);
    const warmup = window.__lscViewer ? null : addStep(`💠 <b>Splat Generator</b> warming up the renderer`);
    waitForViewer().then(ok => {
      if (token !== genToken) return;
      if (warmup) tickStep(warmup);
      if (!ok) return generateSimulated(loc);
      generateReal(loc, token).catch(err => {
        if (token !== genToken) return;
        console.warn('[LSC] live generation failed, falling back:', err);
        addStep(`⚠️ <b>Live world unavailable</b> — showing a postcard instead (${String(err.message || err).slice(0, 80)})`, false);
        generateSimulated(loc);
      });
    });
  }

  window.__lscGenerate = generate; // shared with the WebGL portals
  form.addEventListener('submit', e => { e.preventDefault(); generate(input.value); });
  $$('#quickChips button').forEach(b =>
    b.addEventListener('click', () => { input.value = b.textContent; generate(b.textContent); }));

  function closeModal() {
    genToken++; // abandon any in-flight load (live generation still completes + caches server-side)
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    modal.querySelector('.sm-card').classList.remove('world-open');
    window.__lscViewer && window.__lscViewer.closeModal();
  }
  $('#smClose').addEventListener('click', closeModal);
  $('#smJoinScene').addEventListener('click', () => {
    closeModal();
    setTimeout(() => document.getElementById('explore').scrollIntoView({ behavior: 'smooth' }), 150);
  });
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  $('#smShare').addEventListener('click', () => {
    const t = 'Look who I found hidden in Dublin — the Little Super Claws! littlesuperclaws.ie';
    if (navigator.share) navigator.share({ title: 'Little Super Claws', text: t, url: 'https://littlesuperclaws.ie' }).catch(()=>{});
    else { navigator.clipboard?.writeText(t); flash($('#smShare'), 'Copied!'); }
  });

  /* ---------- Newsletter ---------- */
  $('#newsletter').addEventListener('submit', e => {
    e.preventDefault();
    $('#newsletterNote').innerHTML = '🦞 You\'re on the list! The crew will be in touch.';
    e.target.reset();
  });

  function flash(btn, msg) {
    const o = btn.textContent; btn.textContent = msg;
    setTimeout(() => (btn.textContent = o), 1400);
  }

  /* ---------- Mobile nav ---------- */
  const burger = $('#hamburger'), links = $('#navLinks');
  burger.addEventListener('click', () => links.classList.toggle('open'));
  $$('#navLinks a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));

  /* ---------- Scroll reveals ---------- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  $$('.reveal').forEach(el => io.observe(el));

  /* ---------- Deep-link: ?scene=Temple+Bar auto-opens a generated scene ---------- */
  const deepScene = new URLSearchParams(location.search).get('scene');
  if (deepScene) setTimeout(() => generate(deepScene), 600);

  /* ---------- Year ---------- */
  $('#year').textContent = new Date().getFullYear();
})();
