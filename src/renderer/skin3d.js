// Dependency-free 3D skin viewer built from CSS 3D transforms.
// Supports 64x64 and legacy 64x32 skins, classic (4px) and slim (3px) arms, overlay layers.
(function () {
  const PARTS = (armW) => [
    { n: 'head',  x: -4,       y: 0,  w: 8,    h: 8,  d: 8, uv: [0, 0],   ov: [32, 0] },
    { n: 'body',  x: -4,       y: 8,  w: 8,    h: 12, d: 4, uv: [16, 16], ov: [16, 32] },
    { n: 'rarm',  x: -4 - armW, y: 8, w: armW, h: 12, d: 4, uv: [40, 16], ov: [40, 32], limb: 1 },
    { n: 'larm',  x: 4,        y: 8,  w: armW, h: 12, d: 4, uv: [32, 48], ov: [48, 48], uvOld: [40, 16], limb: -1 },
    { n: 'rleg',  x: -4,       y: 20, w: 4,    h: 12, d: 4, uv: [0, 16],  ov: [0, 32],  limb: -1 },
    { n: 'lleg',  x: 0,        y: 20, w: 4,    h: 12, d: 4, uv: [16, 48], ov: [0, 48],  uvOld: [0, 16], limb: 1 }
  ];

  function face(url, imgW, imgH, tx, ty, tw, th, fw, fh, transform) {
    const el = document.createElement('div');
    el.className = 'sk-face';
    const sx = fw / tw, sy = fh / th;
    el.style.cssText =
      `width:${fw}px;height:${fh}px;left:50%;top:50%;margin-left:${-fw / 2}px;margin-top:${-fh / 2}px;` +
      `background-image:url("${url}");background-size:${imgW * sx}px ${imgH * sy}px;` +
      `background-position:${-tx * sx}px ${-ty * sy}px;transform:${transform}`;
    return el;
  }

  function box(url, imgW, imgH, uv, w, h, d, S, inflate) {
    const dw = (w + inflate * 2) * S, dh = (h + inflate * 2) * S, dd = (d + inflate * 2) * S;
    const [u, v] = uv;
    const el = document.createElement('div');
    el.className = 'sk-box';
    el.style.width = dw + 'px';
    el.style.height = dh + 'px';
    const f = (tx, ty, tw, th, fw, fh, tr) => el.appendChild(face(url, imgW, imgH, tx, ty, tw, th, fw, fh, tr));
    f(u + d,         v + d, w, h, dw, dh, `translateZ(${dd / 2}px)`);                          // front
    f(u + 2 * d + w, v + d, w, h, dw, dh, `rotateY(180deg) translateZ(${dd / 2}px)`);          // back
    f(u,             v + d, d, h, dd, dh, `rotateY(-90deg) translateZ(${dw / 2}px)`);          // char right (viewer left)
    f(u + d + w,     v + d, d, h, dd, dh, `rotateY(90deg) translateZ(${dw / 2}px)`);           // char left
    f(u + d,         v,     w, d, dw, dd, `rotateX(90deg) translateZ(${dh / 2}px)`);           // top
    f(u + d + w,     v,     w, d, dw, dd, `rotateX(-90deg) translateZ(${dh / 2}px) scaleY(-1)`); // bottom
    return el;
  }

  function create(container, opts = {}) {
    const S = opts.scale || 9;
    const state = { ry: opts.ry ?? -28, rx: opts.rx ?? -8, auto: opts.auto !== false, walk: opts.walk !== false, drag: false, t0: performance.now(), raf: 0, limbs: [] };

    container.classList.add('sk-stage');
    container.innerHTML = '';
    const model = document.createElement('div');
    model.className = 'sk-model';
    container.appendChild(model);

    const shadow = document.createElement('div');
    shadow.className = 'sk-shadow';
    container.appendChild(shadow);

    function build(url, slim, imgW, imgH) {
      model.innerHTML = '';
      state.limbs = [];
      const legacy = imgH === 32;
      PARTS(slim ? 3 : 4).forEach((p) => {
        const uv = legacy && p.uvOld ? p.uvOld : p.uv;
        const wrap = document.createElement('div');
        wrap.className = 'sk-part';
        wrap.style.left = p.x * S + 'px';
        wrap.style.top = (p.y - 16) * S + 'px';
        wrap.style.width = p.w * S + 'px';
        wrap.style.height = p.h * S + 'px';
        wrap.appendChild(box(url, imgW, imgH, uv, p.w, p.h, p.d, S, 0));
        if (!legacy || p.n === 'head') {
          const ov = box(url, imgW, imgH, p.ov, p.w, p.h, p.d, S, 0.5);
          ov.classList.add('sk-overlay');
          ov.style.left = -0.5 * S + 'px';
          ov.style.top = -0.5 * S + 'px';
          wrap.appendChild(ov);
        }
        const base = wrap.firstChild;
        base.style.left = '0px'; base.style.top = '0px';
        if (p.limb) { wrap.style.transformOrigin = '50% 0'; state.limbs.push({ el: wrap, dir: p.limb }); }
        model.appendChild(wrap);
      });
    }

    function setSkin(dataUrl, model = 'classic') {
      const img = new Image();
      img.onload = () => build(dataUrl, model === 'slim', img.naturalWidth, img.naturalHeight);
      img.src = dataUrl;
    }

    function frame(now) {
      state.raf = requestAnimationFrame(frame);
      if (!container.isConnected || container.offsetParent === null) return;
      const t = (now - state.t0) / 1000;
      if (state.auto && !state.drag) state.ry += 0.45;
      model.style.transform = `translateY(${state.walk ? Math.sin(t * 5) * -1.2 : 0}px) rotateX(${state.rx}deg) rotateY(${state.ry}deg)`;
      const swing = state.walk ? Math.sin(t * 5) * 32 : Math.sin(t * 1.4) * 3;
      state.limbs.forEach((l) => { l.el.style.transform = `rotateX(${swing * l.dir}deg)`; });
    }
    state.raf = requestAnimationFrame(frame);

    // drag to rotate
    let lx = 0, ly = 0;
    container.addEventListener('pointerdown', (e) => { state.drag = true; lx = e.clientX; ly = e.clientY; container.setPointerCapture(e.pointerId); container.classList.add('grab'); });
    container.addEventListener('pointermove', (e) => {
      if (!state.drag) return;
      state.ry += (e.clientX - lx) * 0.7;
      state.rx = Math.max(-60, Math.min(60, state.rx - (e.clientY - ly) * 0.4));
      lx = e.clientX; ly = e.clientY;
    });
    const end = () => { state.drag = false; container.classList.remove('grab'); };
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);

    return {
      setSkin,
      setAuto: (v) => { state.auto = v; },
      setWalk: (v) => { state.walk = v; },
      view: (ry, rx) => { state.ry = ry; state.rx = rx; },
      destroy: () => cancelAnimationFrame(state.raf)
    };
  }

  // flat head icon (face + hat layer) from a skin data URL
  function faceEl(dataUrl, px) {
    const el = document.createElement('div');
    el.className = 'sk-head-icon';
    el.style.width = el.style.height = px + 'px';
    const s = px / 8;
    const layer = (x, y) => {
      const d = document.createElement('div');
      d.style.cssText = `background-image:url("${dataUrl}");background-size:${64 * s}px auto;background-position:${-x * s}px ${-y * s}px;`;
      el.appendChild(d);
    };
    layer(8, 8); layer(40, 8);
    return el;
  }

  window.Skin3D = { create, faceEl };
})();
