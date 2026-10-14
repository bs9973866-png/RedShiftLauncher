'use strict';
const $ = (id) => document.getElementById(id);
const inv = (ch, p) => window.api.invoke(ch, p);
const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let state = { accounts: [], instances: [], presets: {} };
let versions = [];
let sysinfo = null;
let curSkin = null;
let page = 'play';

const ACC_LABEL = { ely: 'Ely.by', offline: 'Оффлайн', microsoft: 'Microsoft · лицензия', redshift: 'REDSHIFT ID' };
const LOADER_NAME = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const LOADER_ICON = { vanilla: 'MC', fabric: 'FB', quilt: 'QL', forge: 'FG', neoforge: 'NF' };
const THEMES = {
  redshift: ['#ff2d3a', '#ff7a3d'], aurora: ['#2dd4bf', '#8b5cf6'], ember: ['#fb923c', '#f43f5e'], ocean: ['#38bdf8', '#6366f1'],
  toxic: ['#a3e635', '#10b981'], sakura: ['#f472b6', '#c084fc'], gold: ['#fde047', '#f59e0b']
};
const PRESET_NOTE = {
  none: 'Стандартные настройки Java без дополнительных флагов.',
  balanced: 'Сбор мусора G1 с тонкой настройкой пауз — меньше фризов, подходит почти всем.',
  max: 'Как «Баланс» + фиксированный размер памяти и предзагрузка страниц. Лучше всего при 8+ ГБ ОЗУ.',
  lowend: 'Лёгкий сборщик мусора и упрощённая JIT-компиляция — для слабых ПК (2–4 ГБ ОЗУ).'
};

/* ---------- helpers ---------- */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, type === 'err' ? 6000 : 3200);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.btn');
  if (!b || document.body.classList.contains('noanim')) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  b.appendChild(s);
  setTimeout(() => s.remove(), 650);
});
function bindSeg(id, onChange) {
  const root = $(id);
  const set = (v) => root.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset.v) return;
    set(b.dataset.v);
    onChange && onChange(b.dataset.v);
  });
  return set;
}
function bindTabs(id, cb) {
  const root = $(id);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    root.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    cb(b.dataset.tab);
  });
}
const curInst = () => state.instances.find((i) => i.id === state.selectedInstance);
const curAcc = () => state.accounts[state.selected];

/* ---------- window ---------- */
$('wMin').onclick = () => inv('win:min');
$('wMax').onclick = () => inv('win:max');
$('wClose').onclick = () => inv('win:close');

/* ---------- stars background ---------- */
const stars = (() => {
  const cv = $('stars'), ctx = cv.getContext('2d');
  let pts = [], raf = 0, on = false;
  function resize() { cv.width = innerWidth; cv.height = innerHeight; }
  function init() {
    resize();
    pts = Array.from({ length: 80 }, () => ({
      x: Math.random() * cv.width, y: Math.random() * cv.height, r: Math.random() * 1.4 + .3,
      vx: (Math.random() - .5) * .12, vy: -Math.random() * .18 - .03, tw: Math.random() * 6.28
    }));
  }
  function loop() {
    if (!on) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy; p.tw += .02;
      if (p.y < -4) { p.y = cv.height + 4; p.x = Math.random() * cv.width; }
      if (p.x < -4) p.x = cv.width + 4; if (p.x > cv.width + 4) p.x = -4;
      ctx.globalAlpha = .25 + Math.sin(p.tw) * .2 + .2;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    raf = requestAnimationFrame(loop);
  }
  addEventListener('resize', resize);
  init();
  return {
    set(v) { if (v && !on) { on = true; cv.style.display = ''; loop(); } else if (!v) { on = false; cancelAnimationFrame(raf); cv.style.display = 'none'; } }
  };
})();

/* ---------- navigation ---------- */
function moveIndicator() {
  const b = document.querySelector('#nav button.active');
  if (b) $('navInd').style.transform = `translateY(${b.offsetTop}px)`;
}
function showPage(name) {
  page = name;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  moveIndicator();
  $('main').scrollTop = 0;
  if (name === 'mods') modsEnter();
  if (name === 'packs') packsEnter();
  if (name === 'skins') renderSkinsPage();
  if (name === 'settings') renderSettings();
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
$('chip').onclick = () => showPage('account');
addEventListener('resize', moveIndicator);

/* ---------- skins ---------- */
let heroViewer, skinViewer;
async function refreshSkin() {
  try { curSkin = await inv('skin:get', state.selected); } catch { return; }
  heroViewer.setSkin(curSkin.dataUrl, curSkin.model);
  skinViewer.setSkin(curSkin.dataUrl, curSkin.model);
  const face = $('chipFace');
  face.innerHTML = '';
  face.appendChild(Skin3D.faceEl(curSkin.dataUrl, 38));
}
function renderSkinsPage() {
  const a = curAcc();
  $('skinWho').textContent = a ? a.name : 'Нет аккаунта';
  const src = curSkin ? curSkin.source : 'default';
  $('skinInfo').textContent = !a ? 'Добавьте аккаунт на вкладке «Аккаунты».'
    : src === 'custom' ? 'Используется ваш загруженный скин.'
    : src === 'ely' ? 'Скин загружен с Ely.by.'
    : src === 'microsoft' ? 'Скин загружен с серверов Mojang.'
    : a.type === 'ely' ? 'На Ely.by скин не найден — показан стандартный.' : 'Скин не задан — показан стандартный.';
  const canUpload = a && (a.type === 'offline' || a.type === 'redshift');
  $('btnSkinUpload').disabled = !canUpload;
  $('btnSkinReset').disabled = !(a && a.hasSkin) || (a && a.type === 'redshift');
  $('skinNote').textContent = !a ? '' : a.type === 'ely' ? 'Для Ely.by скин меняется на сайте ely.by.'
    : a.type === 'microsoft' ? 'Скин лицензионного аккаунта меняется на minecraft.net.'
    : a.type === 'redshift' ? 'Скин хранится в профиле REDSHIFT и общий с сайтом.' : '';
  $('skinModel').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === (curSkin ? curSkin.model : 'classic')));
}
$('btnSkinUpload').onclick = async () => {
  try {
    state = await inv('skin:upload', state.selected);
    const changed = state._changed;
    await refreshSkin(); renderAll(); renderSkinsPage();
    if (changed) toast('Скин загружен — он появится в игре при следующем запуске');
  } catch (e) { toast(clean(e), 'err'); }
};
$('btnSkinReset').onclick = async () => { state = await inv('skin:reset', state.selected); await refreshSkin(); renderAll(); renderSkinsPage(); toast('Скин сброшен'); };
bindSeg('skinModel', async (v) => {
  state = await inv('skin:model', { index: state.selected, model: v });
  await refreshSkin(); renderSkinsPage();
});
let walkOn = true, autoOn = true;
$('skinWalk').onclick = () => { walkOn = !walkOn; skinViewer.setWalk(walkOn); $('skinWalk').textContent = 'Ходьба: ' + (walkOn ? 'вкл' : 'выкл'); };
$('skinAuto').onclick = () => { autoOn = !autoOn; skinViewer.setAuto(autoOn); $('skinAuto').textContent = 'Вращение: ' + (autoOn ? 'вкл' : 'выкл'); };
$('skinFront').onclick = () => { skinViewer.setAuto(false); skinViewer.view(0, -6); autoOn = false; $('skinAuto').textContent = 'Вращение: выкл'; };
$('skinBack').onclick = () => { skinViewer.setAuto(false); skinViewer.view(180, -6); autoOn = false; $('skinAuto').textContent = 'Вращение: выкл'; };
$('btnElySite').onclick = () => inv('open:url', 'https://ely.by');

/* ---------- render: main parts ---------- */
function renderChip() {
  const a = curAcc();
  $('chipName').textContent = a ? a.name : 'Нет аккаунта';
  $('chipType').textContent = a ? (ACC_LABEL[a.type] || a.type) : 'Нажмите, чтобы войти';
}
function renderHero() {
  const i = curInst();
  $('heroName').textContent = i ? i.name : 'Создайте первую сборку';
  const b = $('heroBadges');
  b.innerHTML = '';
  if (i) {
    const v = document.createElement('span'); v.className = 'badge'; v.textContent = 'Minecraft ' + i.version;
    const l = document.createElement('span'); l.className = 'badge ld'; l.textContent = LOADER_NAME[i.loader] || i.loader;
    b.append(v, l);
  }
  $('btnOptimize').disabled = !i; $('btnOpenInst').disabled = !i; $('btnDelInst').disabled = !i;
}
function renderInstances() {
  const g = $('instGrid');
  g.innerHTML = '';
  state.instances.forEach((i, n) => {
    const d = document.createElement('div');
    d.className = 'inst' + (i.id === state.selectedInstance ? ' sel' : '');
    d.style.animationDelay = n * 55 + 'ms';
    d.innerHTML = '<div class="tick"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div><div class="ic"></div><b></b><small></small>';
    d.querySelector('.ic').textContent = LOADER_ICON[i.loader] || 'MC';
    d.querySelector('b').textContent = i.name;
    d.querySelector('small').textContent = `${i.version} · ${LOADER_NAME[i.loader] || i.loader}`;
    d.onclick = async () => { state = await inv('settings:set', { selectedInstance: i.id }); renderInstances(); renderHero(); };
    g.appendChild(d);
  });
  const add = document.createElement('div');
  add.className = 'inst add';
  add.style.animationDelay = state.instances.length * 55 + 'ms';
  add.innerHTML = '<div><div class="plus">+</div><small>Новая сборка</small></div>';
  add.onclick = openModal;
  g.appendChild(add);
}
async function renderAccounts() {
  const list = $('accList');
  list.innerHTML = '';
  if (!state.accounts.length) { list.innerHTML = '<div class="empty">Пока нет аккаунтов — войдите через Ely.by или добавьте оффлайн-ник.</div>'; return; }
  state.accounts.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.style.animationDelay = i * 60 + 'ms';
    d.innerHTML = '<div class="face"></div><div class="meta"><b></b><span></span></div>';
    d.querySelector('b').textContent = a.name;
    d.querySelector('span').textContent = (ACC_LABEL[a.type] || a.type) + (a.hasSkin ? ' · свой скин' : '');
    const use = document.createElement('button');
    use.className = 'btn ghost sm';
    use.textContent = i === state.selected ? '✓ Выбран' : 'Выбрать';
    use.onclick = async () => { state = await inv('settings:set', { selected: i }); await refreshSkin(); renderAll(); };
    const del = document.createElement('button');
    del.className = 'btn ghost sm danger';
    del.textContent = a.type === 'redshift' ? 'Выйти' : 'Удалить';
    del.onclick = async () => { state = await inv('account:remove', i); await refreshSkin(); renderAll(); };
    d.append(use, del);
    list.appendChild(d);
    inv('skin:get', i).then((s) => { d.querySelector('.face').appendChild(Skin3D.faceEl(s.dataUrl, 56)); }).catch(() => {});
  });
}
function applyAppearance() {
  document.body.dataset.accent = state.accent || 'redshift';
  document.body.classList.toggle('noanim', state.anim === false);
  stars.set(state.particles !== false && state.anim !== false);
  $('consoleBox').open = !!state.showLog;
}
function renderAll() {
  renderChip(); renderHero(); renderInstances(); renderAccounts(); renderRedshift(); applyAppearance();
  if (page === 'skins') renderSkinsPage();
}

/* ---------- create-instance modal ---------- */
let newLoader = 'vanilla';
const setNewLoader = bindSeg('newLoader', (v) => { newLoader = v; });
function fillVersions() {
  const t = $('newType').value, sel = $('newVersion');
  sel.innerHTML = '';
  versions.filter((v) => t === 'all' || v.type === t).forEach((v) => {
    const o = document.createElement('option'); o.value = v.id; o.textContent = v.id; sel.appendChild(o);
  });
}
function openModal() { $('modal').hidden = false; $('newName').focus(); }
function closeModal() { $('modal').hidden = true; }
$('newType').onchange = fillVersions;
$('btnCancelNew').onclick = closeModal;
$('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('btnNew').onclick = openModal;
$('btnCreate').onclick = async () => {
  const version = $('newVersion').value;
  if (!version) return toast('Список версий ещё не загружен', 'err');
  const name = $('newName').value.trim() || `Minecraft ${version}`;
  state = await inv('instance:create', { name, version, loader: newLoader });
  const id = state.selectedInstance;
  $('newName').value = '';
  closeModal(); renderAll();
  toast(`Сборка «${name}» создана`);
  if ($('newFps').checked) runOptimize(id, true);
};

/* ---------- play / launch ---------- */
const log = $('log');
function addLog(t) {
  log.textContent += t + '\n';
  if (log.textContent.length > 200000) log.textContent = log.textContent.slice(-120000);
  log.scrollTop = log.scrollHeight;
}
window.api.on('log', addLog);
window.api.on('progress', (p) => {
  $('statusText').textContent = p.text; $('barFill').style.width = (p.percent || 0) + '%';
  if (packBusy) { $('packText').textContent = p.text; $('packBar').style.width = (p.percent || 0) + '%'; }
});
window.api.on('game:closed', (code) => {
  $('statusText').textContent = `Игра закрыта (код ${code})`;
  $('barFill').style.width = '0';
  $('btnPlay').disabled = false; $('btnKill').hidden = true;
});
$('btnPlay').onclick = async () => {
  if (!state.selectedInstance) { openModal(); return; }
  log.textContent = '';
  $('btnPlay').disabled = true;
  try {
    await inv('game:launch', state.selectedInstance);
    $('btnKill').hidden = false;
  } catch (e) {
    $('statusText').textContent = 'Ошибка: ' + clean(e);
    $('barFill').style.width = '0';
    $('btnPlay').disabled = false;
    toast(clean(e), 'err');
  }
};
$('btnKill').onclick = () => inv('game:kill');
$('btnOpenInst').onclick = () => state.selectedInstance && inv('open:folder', state.selectedInstance);
$('btnDelInst').onclick = async () => {
  const i = curInst();
  if (i && confirm(`Удалить сборку «${i.name}» вместе с её файлами?`)) { state = await inv('instance:delete', i.id); renderAll(); }
};
async function runOptimize(id, silentStart) {
  const btn = $('btnOptimize');
  btn.disabled = true;
  try {
    const r = await inv('perf:optimize', id);
    const inst = state.instances.find((x) => x.id === id);
    if (!r.mods) toast('Применены быстрые настройки видео (для Vanilla FPS-моды не ставятся)');
    else if (r.failed.length) toast(`Оптимизация: установлено ${r.ok.length}, нет для этой версии: ${r.failed.join(', ')}`);
    else toast(`Оптимизация завершена: ${r.ok.length} FPS-модов + настройки видео` + (inst ? ` для «${inst.name}»` : ''));
  } catch (e) { toast(clean(e), 'err'); }
  btn.disabled = false;
}
$('btnOptimize').onclick = () => state.selectedInstance && runOptimize(state.selectedInstance);

/* ---------- accounts ---------- */
function setMsg(el, text, cls = '') { el.textContent = text; el.className = 'msg ' + cls; }
async function elyLogin() {
  const msg = $('elyMsg');
  setMsg(msg, 'Вход…');
  try {
    state = await inv('ely:login', { login: $('elyLogin').value.trim(), password: $('elyPass').value, totp: $('elyTotp').value.trim() });
    $('elyPass').value = ''; $('elyTotp').value = ''; $('rowTotp').hidden = true;
    setMsg(msg, 'Готово!', 'ok');
    await refreshSkin(); renderAll(); toast('Вход через Ely.by выполнен');
  } catch (e) {
    if (String(e.message).includes('NEED_2FA')) { $('rowTotp').hidden = false; setMsg(msg, 'Введите код двухфакторной защиты', 'err'); }
    else setMsg(msg, clean(e), 'err');
  }
}
$('btnEly').onclick = elyLogin;
['elyLogin', 'elyPass', 'elyTotp'].forEach((id) => $(id).addEventListener('keydown', (e) => e.key === 'Enter' && elyLogin()));
$('btnOff').onclick = async () => {
  const n = $('offName').value.trim();
  if (!/^\w{3,16}$/.test(n)) return toast('Ник: 3–16 символов, буквы / цифры / _', 'err');
  state = await inv('offline:add', n); $('offName').value = '';
  await refreshSkin(); renderAll(); toast('Оффлайн-аккаунт добавлен');
};

/* ---------- mods ---------- */
let modSource = 'modrinth', modKind = 'mod', modTab = 'catalog', modOffset = 0, modLoading = false, modInst = null;
bindSeg('modSource', (v) => { modSource = v; if (modTab === 'catalog') search(false); });
bindSeg('modKind', (v) => { modKind = v; modTab === 'catalog' ? search(false) : renderInstalled(); });
bindTabs('modTabs', (t) => {
  modTab = t;
  $('modSource').style.display = t === 'catalog' ? '' : 'none';
  document.querySelector('.search').style.display = t === 'catalog' ? '' : 'none';
  $('btnSearch').style.display = t === 'catalog' ? '' : 'none';
  t === 'catalog' ? search(false) : renderInstalled();
});
function modsEnter() {
  const i = curInst();
  $('modHint').textContent = i ? `Сборка: ${i.name} · ${i.version} · ${LOADER_NAME[i.loader]}. Файлы попадут в её папку.` : 'Сначала создайте сборку — контент подбирается под её версию и загрузчик.';
  if (i && modInst !== i.id) {          // first visit or the selected instance changed
    modInst = i.id;
    modTab === 'catalog' ? search(false) : renderInstalled();
  }
}
function skeletons(n = 4) {
  $('modList').innerHTML = Array.from({ length: n }, () => '<div class="skel"></div>').join('');
}
async function search(more) {
  const inst = curInst();
  modsEnter();
  if (!inst) { $('modList').innerHTML = ''; return; }
  if (modLoading) return;
  modLoading = true;
  if (!more) { modOffset = 0; skeletons(); $('modMore').hidden = true; }
  try {
    const res = await inv(modSource + ':search', { query: $('modQuery').value, kind: modKind, instanceId: inst.id, offset: modOffset });
    if (!more) $('modList').innerHTML = '';
    if (!res.length && !more) $('modList').innerHTML = '<div class="empty">Ничего не найдено для этой версии и загрузчика.</div>';
    modOffset += res.length;
    res.forEach((m, n) => addMod(m, n));
    $('modMore').hidden = res.length < 20;
  } catch (e) {
    if (!more) $('modList').innerHTML = '';
    $('modHint').textContent = clean(e);
    toast(clean(e), 'err');
  }
  modLoading = false;
}
function addMod(m, n) {
  const d = document.createElement('div');
  d.className = 'item';
  d.style.animationDelay = Math.min(n, 12) * 40 + 'ms';
  const img = m.icon ? Object.assign(document.createElement('img'), { src: m.icon, loading: 'lazy' }) : Object.assign(document.createElement('div'), { className: 'ph' });
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<b></b><span class="d"></span><span class="s"></span>';
  meta.querySelector('b').textContent = m.title;
  meta.querySelector('.d').textContent = m.description || '';
  meta.querySelector('.s').textContent = `${m.author} · ${(m.downloads || 0).toLocaleString('ru')} загрузок`;
  const btn = document.createElement('button');
  btn.className = 'btn sm';
  btn.textContent = 'Скачать';
  btn.onclick = async () => {
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try {
      await inv(m.source + ':install', { id: m.id, kind: modKind, instanceId: state.selectedInstance });
      btn.innerHTML = '✓ Готово';
      toast(`«${m.title}» установлен`);
    } catch (e) { btn.disabled = false; btn.textContent = 'Скачать'; toast(clean(e), 'err'); }
  };
  d.append(img, meta, btn);
  $('modList').appendChild(d);
}
$('btnSearch').onclick = () => search(false);
$('btnMore').onclick = () => search(true);
$('modQuery').addEventListener('keydown', (e) => e.key === 'Enter' && search(false));

async function renderInstalled() {
  const inst = curInst();
  const list = $('modList');
  $('modMore').hidden = true;
  if (!inst) { list.innerHTML = ''; return; }
  const files = await inv('mods:installed', { instanceId: inst.id, kind: modKind });
  list.innerHTML = '';
  if (!files.length) { list.innerHTML = '<div class="empty">Здесь пока пусто.</div>'; return; }
  files.forEach((f, n) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.style.animationDelay = Math.min(n, 12) * 30 + 'ms';
    d.innerHTML = '<div class="ph"></div><div class="meta"><b></b><span></span></div>';
    d.querySelector('b').textContent = f.file;
    d.querySelector('span').textContent = (f.size / 1048576).toFixed(2) + ' МБ';
    const del = document.createElement('button');
    del.className = 'btn ghost sm danger';
    del.textContent = 'Удалить';
    del.onclick = async () => { await inv('mods:remove', { instanceId: inst.id, kind: modKind, file: f.file }); d.remove(); toast('Удалено'); };
    d.appendChild(del);
    list.appendChild(d);
  });
}



/* ---------- REDSHIFT ID ---------- */
let rsBusy = false;
function rsMsg(id, text, cls = '') { setMsg($(id), text, cls); }
function renderRedshift() {
  const r = state.redshift || {};
  $('rsOut').hidden = !!r.loggedIn;
  $('rsIn').hidden = !r.loggedIn;
  $('btnRsSite2').style.display = r.siteUrl ? '' : 'none';
  if (!r.loggedIn) return;
  const acc = state.accounts.find((a) => a.type === 'redshift');
  $('rsName').textContent = r.username || (acc && acc.name) || '—';
  $('rsMail').textContent = r.email;
  const st = $('rsStatus');
  st.textContent = r.online === false ? 'Вход выполнен · нет связи с сервером' : 'Вы вошли в REDSHIFT ID';
  st.classList.toggle('off', r.online === false);
  if (document.activeElement !== $('rsNick')) $('rsNick').value = r.username || '';
  const face = $('rsFace');
  face.innerHTML = '';
  const idx = state.accounts.findIndex((a) => a.type === 'redshift');
  if (idx >= 0) inv('skin:get', idx).then((s) => face.appendChild(Skin3D.faceEl(s.dataUrl, 72))).catch(() => {});
}
async function rsRun(btn, msgId, fn, okText) {
  if (rsBusy) return;                               // protect against double clicks
  rsBusy = true; btn.disabled = true;
  const label = btn.textContent;
  rsMsg(msgId, 'Подождите…');
  try {
    const r = await fn();
    if (r && r.accounts) { state = r; }
    await refreshSkin(); renderAll();
    if (r && r._warn) rsMsg(msgId, r._warn, 'err'); else rsMsg(msgId, okText || '', 'ok');
  } catch (e) {
    rsMsg(msgId, clean(e), 'err');
    if (/session_expired|Сессия истекла/.test(String(e && e.message))) { state = await inv('state:get'); renderAll(); }
  }
  rsBusy = false; btn.disabled = false; btn.textContent = label;
}
$('btnRsLogin').onclick = () => rsRun($('btnRsLogin'), 'rsMsg', async () => {
  const r = await inv('rs:login', { email: $('rsEmail').value.trim(), password: $('rsPass').value });
  $('rsPass').value = '';
  toast('Вы вошли в REDSHIFT ID');
  return r;
});
['rsEmail', 'rsPass'].forEach((id) => $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('btnRsLogin').click()));
$('btnRsLogout').onclick = () => rsRun($('btnRsLogout'), 'rsMsgIn', async () => { const r = await inv('rs:logout'); toast('Вы вышли из REDSHIFT ID'); return r; });
$('btnRsSkin').onclick = () => rsRun($('btnRsSkin'), 'rsMsgIn', () => inv('rs:refresh'), 'Профиль и скин обновлены');
$('btnRsNick').onclick = () => rsRun($('btnRsNick'), 'rsMsgIn', () => inv('rs:nick', $('rsNick').value.trim()), 'Ник сохранён — он появится и на сайте');
$('btnRsUpload').onclick = () => rsRun($('btnRsUpload'), 'rsMsgIn', async () => {
  const idx = state.accounts.findIndex((a) => a.type === 'redshift');
  const r = await inv('skin:upload', idx);
  if (r._changed) toast('Скин загружен в профиль REDSHIFT');
  return r;
});
const openSite = async () => { try { await inv('rs:site'); } catch (e) { toast(clean(e), 'err'); } };
$('btnRsAccount').onclick = () => { const u = state.redshift && state.redshift.siteUrl; u ? openSite() : showPage('skins'); };
$('btnRsSite2').onclick = openSite;
window.api.on('rs:synced', async (p) => {
  state = await inv('state:get'); await refreshSkin(); renderAll();
  if (p && p.error) toast(p.error, 'err');
});

/* ---------- Microsoft (licensed) ---------- */
let msBusy = false;
window.api.on('ms:code', (c) => { $('msCode').textContent = c.code; $('msCodeBox').hidden = false; setMsg($('msMsg'), 'Ожидаю подтверждения на странице Microsoft…'); });
$('btnMs').onclick = async () => {
  if (msBusy) return;
  msBusy = true; $('btnMs').disabled = true; $('btnMsCancel').hidden = false; setMsg($('msMsg'), 'Запрашиваю код…');
  try {
    state = await inv('ms:login');
    await refreshSkin(); renderAll();
    setMsg($('msMsg'), 'Готово!', 'ok'); toast('Лицензионный аккаунт добавлен');
  } catch (e) { setMsg($('msMsg'), clean(e), 'err'); }
  $('msCodeBox').hidden = true; $('btnMsCancel').hidden = true; $('btnMs').disabled = false; msBusy = false;
};
$('btnMsCancel').onclick = () => { inv('ms:cancel'); setMsg($('msMsg'), 'Отменяю…'); };

/* ---------- modpacks ---------- */
let packSource = 'modrinth', packOffset = 0, packLoading = false, packBusy = false, packLoaded = false;
bindSeg('packSource', (v) => { packSource = v; packSearch(false); });
function packsEnter() { if (!packLoaded) { packLoaded = true; packSearch(false); } }
async function packSearch(more) {
  if (packLoading) return;
  packLoading = true;
  const list = $('packList');
  if (!more) { packOffset = 0; list.innerHTML = Array.from({ length: 4 }, () => '<div class="skel"></div>').join(''); $('packMore').hidden = true; }
  try {
    const res = await inv('packs:search', { source: packSource, query: $('packQuery').value, offset: packOffset });
    if (!more) list.innerHTML = '';
    if (!res.length && !more) list.innerHTML = '<div class="empty">Ничего не найдено.</div>';
    packOffset += res.length;
    res.forEach((m, n) => addPack(m, n));
    $('packMore').hidden = res.length < 20;
  } catch (e) {
    if (!more) list.innerHTML = '<div class="empty"></div>';
    if (!more) list.firstChild.textContent = clean(e);
    toast(clean(e), 'err');
  }
  packLoading = false;
}
function setPackBusy(on, text) {
  packBusy = on;
  $('packProg').hidden = !on;
  if (on) { $('packText').textContent = text || ''; $('packBar').style.width = '0'; }
  document.querySelectorAll('#packList .btn, #btnImportPack, #btnExportPack').forEach((b) => { b.disabled = on; });
}
function afterPackInstalled(r) {
  state = r.state;
  renderAll();
  toast(`Модпак «${r.name}» установлен — он уже в списке сборок`);
  if (r.missing && r.missing.length) toast(`Не удалось скачать ${r.missing.length} файл(ов) (запрещено авторами): ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''}`, 'err');
}
function addPack(m, n) {
  const d = document.createElement('div');
  d.className = 'item';
  d.style.animationDelay = Math.min(n, 12) * 40 + 'ms';
  const img = m.icon ? Object.assign(document.createElement('img'), { src: m.icon, loading: 'lazy' }) : Object.assign(document.createElement('div'), { className: 'ph' });
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<b></b><span class="d"></span><span class="s"></span>';
  meta.querySelector('b').textContent = m.title;
  meta.querySelector('.d').textContent = m.description || '';
  meta.querySelector('.s').textContent = `${m.author} · ${(m.downloads || 0).toLocaleString('ru')} загрузок`;
  const btn = document.createElement('button');
  btn.className = 'btn sm';
  btn.textContent = 'Установить';
  btn.onclick = async () => {
    setPackBusy(true, 'Подготовка…');
    btn.innerHTML = '<span class="spin"></span>';
    try { afterPackInstalled(await inv('packs:install', { source: m.source, id: m.id })); btn.textContent = '✓ Установлено'; }
    catch (e) { btn.textContent = 'Установить'; toast(clean(e), 'err'); }
    setPackBusy(false);
    if (btn.textContent !== '✓ Установлено') btn.disabled = false;
  };
  d.append(img, meta, btn);
  $('packList').appendChild(d);
}
$('btnPackSearch').onclick = () => packSearch(false);
$('btnPackMore').onclick = () => packSearch(true);
$('packQuery').addEventListener('keydown', (e) => e.key === 'Enter' && packSearch(false));
$('btnImportPack').onclick = async () => {
  setPackBusy(true, 'Открываю модпак…');
  try {
    const r = await inv('packs:import');
    if (r) afterPackInstalled(r);
  } catch (e) { toast(clean(e), 'err'); }
  setPackBusy(false);
};
$('btnExportPack').onclick = async () => {
  if (!state.selectedInstance) return toast('Сначала выберите сборку на вкладке «Играть»', 'err');
  try {
    const r = await inv('packs:export', { instanceId: state.selectedInstance, saves: $('packSaves').checked });
    if (r) toast(`Сборка экспортирована (${(r.size / 1048576).toFixed(1)} МБ). Файл открывается в Redshift, Modrinth App и Prism.`);
  } catch (e) { toast(clean(e), 'err'); }
};

/* ---------- settings ---------- */
let saveTimer;
async function saveSettings(patch) {
  state = await inv('settings:set', patch);
  setMsg($('saveMsg'), 'Сохранено ✓', 'ok');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setMsg($('saveMsg'), ''), 1800);
}
bindTabs('setTabs', (t) => {
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'set-' + t));
});
const setBehavior = bindSeg('behavior', (v) => saveSettings({ behavior: v }));
const setLevel = bindSeg('videoLevel', (v) => saveSettings({ videoLevel: v }));
const setPreset = bindSeg('jvmPreset', (v) => { $('presetNote').textContent = PRESET_NOTE[v] || ''; saveSettings({ jvmPreset: v }); });

function buildSettingsOnce() {
  // JVM preset buttons
  const jp = $('jvmPreset');
  jp.innerHTML = '';
  Object.entries(state.presets).forEach(([k, title]) => {
    const b = document.createElement('button'); b.dataset.v = k; b.textContent = title; jp.appendChild(b);
  });
  // theme swatches
  const sw = $('swatches');
  sw.innerHTML = '';
  Object.entries(THEMES).forEach(([k, [a, b]]) => {
    const d = document.createElement('div');
    d.className = 'sw'; d.dataset.k = k; d.title = k; d.style.background = `linear-gradient(135deg,${a},${b})`; d.style.color = a;
    d.onclick = () => {
      document.body.dataset.accent = k;
      sw.querySelectorAll('.sw').forEach((x) => x.classList.toggle('active', x === d));
      saveSettings({ accent: k });
    };
    sw.appendChild(d);
  });
}
function renderSettings() {
  $('width').value = state.width || '';
  $('height').value = state.height || '';
  $('fullscreen').checked = !!state.fullscreen;
  setBehavior(state.behavior || 'keep');
  $('javaPath').value = state.javaPath || '';
  $('cfKey').value = state.cfKey || '';
  $('sbKey').value = state.sbKey || '';
  $('siteUrl').value = state.siteUrl || '';
  $('msClientId').value = state.msClientId || '';
  $('ram').value = state.ram; $('ramVal').textContent = state.ram;
  setPreset(state.jvmPreset || 'balanced');
  $('presetNote').textContent = PRESET_NOTE[state.jvmPreset] || '';
  $('jvmArgs').value = state.jvmArgs || '';
  $('autoVideo').checked = !!state.autoVideo;
  setLevel(state.videoLevel || 'balanced');
  $('anim').checked = state.anim !== false;
  $('particles').checked = state.particles !== false;
  $('showLog').checked = !!state.showLog;
  document.querySelectorAll('#swatches .sw').forEach((x) => x.classList.toggle('active', x.dataset.k === (state.accent || 'redshift')));
  if (sysinfo) {
    $('sysInfo').innerHTML = `<span>ОЗУ: <b>${(sysinfo.totalMem / 1024).toFixed(1)} ГБ</b></span><span>Свободно: <b>${(sysinfo.freeMem / 1024).toFixed(1)} ГБ</b></span><span>Потоков CPU: <b>${sysinfo.cpus}</b></span><span>Рекомендуем: <b>${sysinfo.recommended} МБ</b></span>`;
    $('ram').max = Math.max(2048, Math.floor((sysinfo.totalMem - 1024) / 256) * 256);
  }
}
$('ram').oninput = () => { $('ramVal').textContent = $('ram').value; };
$('ram').onchange = () => saveSettings({ ram: +$('ram').value });
$('ramAuto').onclick = () => { if (sysinfo) { $('ram').value = sysinfo.recommended; $('ramVal').textContent = sysinfo.recommended; saveSettings({ ram: sysinfo.recommended }); } };
const num = (v) => Math.max(0, parseInt(v, 10) || 0);
$('width').onchange = () => saveSettings({ width: num($('width').value) });
$('height').onchange = () => saveSettings({ height: num($('height').value) });
$('fullscreen').onchange = () => saveSettings({ fullscreen: $('fullscreen').checked });
$('javaPath').onchange = () => saveSettings({ javaPath: $('javaPath').value.trim() });
$('cfKey').onchange = () => saveSettings({ cfKey: $('cfKey').value.trim() });
$('sbKey').onchange = async () => {
  try { await saveSettings({ sbKey: $('sbKey').value.trim() }); renderAll(); }
  catch (e) { toast(clean(e), 'err'); $('sbKey').value = state.sbKey || ''; }   // e.g. a secret / service_role key is refused
};
$('siteUrl').onchange = async () => { await saveSettings({ siteUrl: $('siteUrl').value.trim() }); renderAll(); };
$('msClientId').onchange = () => saveSettings({ msClientId: $('msClientId').value.trim() });
$('jvmArgs').onchange = () => saveSettings({ jvmArgs: $('jvmArgs').value.trim() });
$('autoVideo').onchange = () => saveSettings({ autoVideo: $('autoVideo').checked });
$('anim').onchange = async () => { await saveSettings({ anim: $('anim').checked }); applyAppearance(); };
$('particles').onchange = async () => { await saveSettings({ particles: $('particles').checked }); applyAppearance(); };
$('showLog').onchange = async () => { await saveSettings({ showLog: $('showLog').checked }); applyAppearance(); };
$('btnOpenData').onclick = () => inv('open:folder', 'root');
$('cfLink').onclick = (e) => { e.preventDefault(); inv('open:url', 'https://console.curseforge.com'); };

/* ---------- init ---------- */
(async () => {
  heroViewer = Skin3D.create($('heroSkin'), { scale: 7, walk: false, ry: -25 });
  skinViewer = Skin3D.create($('skinStage'), { scale: 11, walk: true });
  state = await inv('state:get');
  buildSettingsOnce();
  renderAll();
  moveIndicator();
  inv('sys:info').then((s) => { sysinfo = s; });
  refreshSkin();
  try { versions = await inv('versions:list'); fillVersions(); }
  catch { $('statusText').textContent = 'Не удалось загрузить список версий (нет интернета?)'; }
})();
