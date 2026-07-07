/* ============================================================
   Little Super Claws — sun-control.js
   A tiny draggable "sun pad": drag horizontally to swing the
   sun's azimuth, vertically for elevation; ↺ resets to the
   world's estimated lighting. Pure DOM, no dependencies.

   createSunControl(hostEl, { get, set, reset }) → { el, sync, show, dispose }
     get()            → { azimuth, elevation, source }
     set(az, el)      — called live during drags (mark source='user')
     reset()          — re-apply the estimated/world lighting
   ============================================================ */
const TAU = Math.PI * 2;
const EL_MIN = 0.08, EL_MAX = Math.PI / 2 - 0.02;

export function createSunControl(hostEl, { get, set, reset }) {
  const el = document.createElement('div');
  el.className = 'sun-pad';
  el.title = 'Drag to move the sun';
  el.innerHTML = `
    <div class="sun-pad-grid"></div>
    <div class="sun-pad-dot"></div>
    <button class="sun-pad-reset" type="button" title="Reset to world lighting">&#8634;</button>
    <span class="sun-pad-label">SUN</span>`;
  const dot = el.querySelector('.sun-pad-dot');
  const resetBtn = el.querySelector('.sun-pad-reset');

  function sync() {
    const s = get();
    if (!s) return;
    // azimuth wraps around x, elevation maps to y (top = overhead)
    let ax = (s.azimuth / TAU) % 1;
    if (ax < 0) ax += 1;
    const ay = 1 - (s.elevation - EL_MIN) / (EL_MAX - EL_MIN);
    dot.style.left = `${8 + ax * (el.clientWidth - 16)}px`;
    dot.style.top = `${8 + Math.max(0, Math.min(1, ay)) * (el.clientHeight - 16)}px`;
  }

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target === resetBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const s = get();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, az: s.azimuth, el: s.elevation };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const az = drag.az + ((e.clientX - drag.x) / el.clientWidth) * TAU;
    const elev = Math.max(EL_MIN, Math.min(EL_MAX,
      drag.el + ((drag.y - e.clientY) / el.clientHeight) * (Math.PI / 2)));
    set(az, elev);
    sync();
  });
  const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  resetBtn.addEventListener('click', (e) => { e.stopPropagation(); reset(); sync(); });

  hostEl.appendChild(el);
  requestAnimationFrame(sync);

  return {
    el,
    sync,
    show(on) { el.classList.toggle('on', !!on); },
    dispose() { el.remove(); },
  };
}
