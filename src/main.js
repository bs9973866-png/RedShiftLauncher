const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const { Client } = require('minecraft-launcher-core');
const { LOADERS, installLoader, modLoaders } = require('./loaders');
const skinServer = require('./skinserver');
const perf = require('./perf');
const modpacksModule = require('./modpacks');
const CONFIG = require('./config');
const supabaseMod = require('./supabase');
const msauthMod = require('./msauth');

app.setAppUserModelId('com.redshift.launcher');

// ---------- paths & storage ----------
const DATA = app.getPath('userData');
const ROOT = path.join(DATA, 'minecraft');          // shared libraries / assets / versions
const INSTANCES = path.join(DATA, 'instances');     // one game dir per instance
const JAVA_DIR = path.join(DATA, 'java');
const SKINS = path.join(DATA, 'skins');
const TMP = path.join(DATA, 'tmp');
const AUTHLIB = path.join(DATA, 'authlib-injector.jar');
const SETTINGS = path.join(DATA, 'settings.json');
[ROOT, INSTANCES, JAVA_DIR, SKINS, TMP].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const defaults = {
  accounts: [],              // {type:'ely'|'offline', name, uuid, accessToken?, clientToken?, skinFile?, skinModel?}
  selected: -1,
  instances: [],             // {id, name, version, loader, tuned?}
  selectedInstance: null,
  ram: 4096,
  cfKey: '',
  javaPath: '',
  jvmPreset: 'balanced',
  jvmArgs: '',
  width: 0,
  height: 0,
  fullscreen: false,
  behavior: 'keep',          // keep | minimize
  accent: 'redshift',
  anim: true,
  particles: true,
  autoVideo: true,
  videoLevel: 'balanced',    // balanced | extreme
  showLog: false,
  sbKey: '',                 // Supabase publishable key (optional override of config.js)
  msClientId: '',            // Azure public client id for Microsoft accounts
  siteUrl: ''                // REDSHIFT website (optional)
};
let settings = { ...defaults };
try { settings = { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
const SETTABLE = ['ram', 'cfKey', 'javaPath', 'selected', 'selectedInstance', 'jvmPreset', 'jvmArgs', 'width', 'height',
  'fullscreen', 'behavior', 'accent', 'anim', 'particles', 'autoVideo', 'videoLevel', 'showLog', 'sbKey', 'msClientId', 'siteUrl'];

let win;
const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);
const UA = 'RedshiftLauncher/1.0 (minecraft launcher)';
const errText = (e) => (e && e.message) || String(e);

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}
async function download(url, dest, headers = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed ${r.status}: ${url}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 740, minWidth: 980, minHeight: 640,
    frame: false,
    backgroundColor: '#0b0e17',
    title: 'Redshift Launcher',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
}
app.whenReady().then(async () => {
  createWindow();
  try {
    sb.setKey(cfg().key);
    const si = await sb.init();                                   // restores the saved (encrypted) session, refreshes if expired
    if (si.loggedIn) { await rsSync({ select: false }); send('rs:synced'); }
    else if (settings.accounts.some((a) => a.type === 'redshift')) { rsDropLocal(); send('rs:synced'); }   // saved session is gone
  } catch (e) {
    if (e && e.code === 'session_expired') rsDropLocal();
    send('rs:synced', { error: errMsg(e) });
  }
});
app.on('window-all-closed', () => { skinServer.stop(); app.quit(); });

ipcMain.handle('win:min', () => win.minimize());
ipcMain.handle('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => win.close());
ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

// ---------- effective connection config / secure storage ----------
const cfg = () => ({
  url: CONFIG.supabaseUrl,
  // a secret / service_role key must never be used in a client app: treat it as "no key"
  key: [(settings.sbKey || CONFIG.supabaseKey || '').trim()].map((k) => (CONFIG.keyProblem(k) ? '' : k))[0],
  siteUrl: (settings.siteUrl || CONFIG.siteUrl || '').trim(),
  msClientId: (settings.msClientId || CONFIG.msClientId || '').trim()
});
function secureOk() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // Linux without a keyring falls back to a hard-coded password: not secure, treat as unavailable
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch { return false; }
}
// Encrypted with the OS credential store (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
function secureStore(name) {
  const file = path.join(DATA, name + '.bin');
  return {
    load() { if (!secureOk() || !fs.existsSync(file)) return null; try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch { return null; } },
    save(obj) { if (!secureOk()) return false; fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(obj))); return true; },
    clear() { fs.rmSync(file, { force: true }); }
  };
}
const sb = supabaseMod.create({
  url: CONFIG.supabaseUrl, key: cfg().key, bucket: CONFIG.skinsBucket, skinPathTemplate: CONFIG.skinPathTemplate,
  store: secureStore('rs-session')
});

// ---------- state ----------
const publicState = () => ({
  ...settings,
  accounts: settings.accounts.map((a) => ({
    type: a.type, name: a.name, uuid: a.uuid, hasSkin: !!(a.skinFile && fs.existsSync(a.skinFile)), skinModel: a.skinModel || 'classic',
    rsUsername: a.rsUsername
  })),
  redshift: { ...sb.info(), username: (settings.accounts.find((a) => a.type === 'redshift') || {}).rsUsername || '', online: rsOnline, secure: secureOk(), siteUrl: cfg().siteUrl },
  msReady: !!cfg().msClientId,
  presets: Object.fromEntries(Object.entries(perf.PRESETS).map(([k, v]) => [k, v.title])),
  loaders: LOADERS,
  platform: process.platform
});
ipcMain.handle('state:get', () => publicState());
ipcMain.handle('settings:set', (_e, patch) => {
  if ('sbKey' in patch) { const bad = CONFIG.keyProblem(String(patch.sbKey || '').trim()); if (bad) throw new Error(bad); }
  for (const k of SETTABLE) if (k in patch) settings[k] = patch[k];
  if ('sbKey' in patch) sb.setKey(cfg().key);
  save(); return publicState();
});
ipcMain.handle('open:folder', (_e, which) => {
  const p = which === 'root' ? DATA : path.join(INSTANCES, path.basename(which));
  fs.mkdirSync(p, { recursive: true }); shell.openPath(p);
});
ipcMain.handle('sys:info', () => {
  const total = Math.round(os.totalmem() / 1048576);
  const rec = Math.min(8192, Math.max(2048, Math.round((total / 2) / 512) * 512));
  return { totalMem: total, freeMem: Math.round(os.freemem() / 1048576), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model || '', recommended: rec };
});

// ---------- accounts ----------
const ELY = 'https://authserver.ely.by';
ipcMain.handle('ely:login', async (_e, { login, password, totp }) => {
  const clientToken = crypto.randomUUID().replace(/-/g, '');
  const pass = totp ? `${password}:${totp}` : password; // Ely.by two-factor: password:token
  const r = await fetch(`${ELY}/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ username: login, password: pass, clientToken, requestUser: true })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (body.error === 'ForbiddenOperationException' && /two factor/i.test(body.errorMessage || '')) throw new Error('NEED_2FA');
    throw new Error(body.errorMessage || `Ошибка Ely.by (${r.status})`);
  }
  const acc = { type: 'ely', name: body.selectedProfile.name, uuid: body.selectedProfile.id, accessToken: body.accessToken, clientToken };
  settings.accounts = settings.accounts.filter((a) => !(a.type === 'ely' && a.uuid === acc.uuid));
  settings.accounts.push(acc);
  settings.selected = settings.accounts.length - 1;
  save(); return publicState();
});
ipcMain.handle('offline:add', (_e, name) => {
  const uuid = crypto.createHash('md5').update('OfflinePlayer:' + name).digest('hex');
  settings.accounts.push({ type: 'offline', name, uuid, skinModel: 'classic' });
  settings.selected = settings.accounts.length - 1;
  save(); return publicState();
});
ipcMain.handle('account:remove', async (_e, i) => {
  const acc = settings.accounts[i];
  if (acc && acc.type === 'redshift') return rsLogout();
  if (acc && acc.type === 'microsoft') msDel(acc.uuid);
  if (acc && acc.skinFile) fs.rmSync(acc.skinFile, { force: true });
  settings.accounts.splice(i, 1);
  settings.selected = settings.accounts.length ? 0 : -1;
  save(); return publicState();
});

async function ensureElyToken(acc) {
  const v = await fetch(`${ELY}/auth/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: acc.accessToken })
  });
  if (v.ok) return;
  const r = await fetch(`${ELY}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: acc.accessToken, clientToken: acc.clientToken })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Сессия Ely.by истекла — войдите заново');
  acc.accessToken = body.accessToken; save();
}
async function ensureAuthlib() {
  if (fs.existsSync(AUTHLIB)) return AUTHLIB;
  const meta = await getJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
  await download(meta.download_url, AUTHLIB);
  return AUTHLIB;
}

// ---------- REDSHIFT ID (shared Supabase account) ----------
let rsOnline = true;
const offlineUuid = (name) => crypto.createHash('md5').update('OfflinePlayer:' + name).digest('hex');
function sanitizeNick(n) {                       // Minecraft nick: 3-16 chars [A-Za-z0-9_]
  let t = String(n || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16);
  while (t.length < 3) t += '_';
  return t;
}
const rsSkinCache = (uid) => path.join(SKINS, `rs-${uid}.png`);
const errMsg = (e) => (e && e.message) || String(e);

// Pull profile (+ skin) from Supabase and mirror it into a local "redshift" game account.
async function rsSync({ select } = {}) {
  const si = sb.info();
  if (!si.loggedIn) return { warn: '' };
  let warn = '', profile = null;
  try { profile = await sb.getProfile(); rsOnline = true; }
  catch (e) { if (e.code === 'network') rsOnline = false; else if (e.code === 'session_expired') throw e; else warn = errMsg(e); }

  let acc = settings.accounts.find((a) => a.type === 'redshift');
  if (acc && acc.rsUserId && acc.rsUserId !== si.userId) {            // a different website user logged in
    if (acc.skinFile) fs.rmSync(acc.skinFile, { force: true });
    settings.accounts.splice(settings.accounts.indexOf(acc), 1); acc = null;
  }
  if (!acc) { acc = { type: 'redshift', skinModel: 'classic' }; settings.accounts.push(acc); }
  const username = (profile && profile.username) || acc.rsUsername || (si.email || 'player').split('@')[0];
  acc.rsUsername = username; acc.rsUserId = si.userId; acc.name = sanitizeNick(username); acc.uuid = offlineUuid(acc.name);

  if (profile && profile.skin_path) {
    try {
      const buf = await sb.downloadSkin(profile.skin_path);
      if (buf) { supabaseMod.validateSkinPng(buf); fs.writeFileSync(rsSkinCache(si.userId), buf); acc.skinFile = rsSkinCache(si.userId); }
      else warn = warn || 'Файл скина не найден в хранилище — загрузите скин заново.';
    } catch (e) { if (e.code !== 'network') warn = warn || errMsg(e); else rsOnline = false; }
  }
  if (select) settings.selected = settings.accounts.indexOf(acc);
  save();
  return { warn };
}
function rsDropLocal() {                           // forget the local mirror of the website account
  const acc = settings.accounts.find((a) => a.type === 'redshift');
  if (acc) {
    if (acc.skinFile) fs.rmSync(acc.skinFile, { force: true });
    settings.accounts.splice(settings.accounts.indexOf(acc), 1);
  }
  settings.selected = settings.accounts.length ? 0 : -1;
  save();
}
async function rsLogout() {
  await sb.signOut();
  rsDropLocal();
  return publicState();
}
// runs a Supabase-backed action; if the server says the session is dead, clean up local state too
async function rsGuard(fn) {
  try { return await fn(); }
  catch (e) { if (e && e.code === 'session_expired') rsDropLocal(); throw e; }
}
ipcMain.handle('rs:login', async (_e, { email, password }) => {
  if (!email || !password) throw new Error('Введите почту и пароль');
  sb.setKey(cfg().key);
  await sb.signIn(email, password);
  const { warn } = await rsSync({ select: true });
  return { ...publicState(), _warn: warn };
});
ipcMain.handle('rs:logout', () => rsLogout());
ipcMain.handle('rs:refresh', () => rsGuard(async () => {
  const { warn } = await rsSync({ select: false });
  return { ...publicState(), _warn: warn };
}));
ipcMain.handle('rs:nick', (_e, nick) => rsGuard(async () => {
  if (!/^\w{3,16}$/.test(nick || '')) throw new Error('Ник: 3–16 символов, буквы / цифры / _');
  await sb.updateProfile({ username: nick });
  const { warn } = await rsSync({ select: false });
  return { ...publicState(), _warn: warn };
}));
ipcMain.handle('rs:site', () => { const u = cfg().siteUrl; if (/^https:\/\//.test(u)) shell.openExternal(u); else throw new Error('Адрес сайта не задан (Настройки → Основные)'); });

// ---------- Microsoft (licensed Minecraft: Java Edition) ----------
const msStore = secureStore('ms-session');
const msMem = new Map();                          // uuid -> { refresh, mcToken, mcExpires }
const msGet = (uuid) => msMem.get(uuid) || (msStore.load() || {})[uuid] || null;
function msSet(uuid, t) {
  msMem.set(uuid, t);
  try { msStore.save({ ...(msStore.load() || {}), [uuid]: { refresh: t.refresh } }); } catch { /* memory only */ }
}
function msDel(uuid) {
  msMem.delete(uuid);
  try { const m = msStore.load() || {}; delete m[uuid]; msStore.save(m); } catch { /* ignore */ }
}
let msAbort = null;
const msClient = () => msauthMod.create({ clientId: cfg().msClientId });

ipcMain.handle('ms:login', async () => {
  const ms = msClient();
  const dc = await ms.deviceCode();
  send('ms:code', { code: dc.user_code, uri: dc.verification_uri });
  if (/^https:\/\//.test(dc.verification_uri)) shell.openExternal(dc.verification_uri);
  msAbort = new AbortController();
  let tok;
  try { tok = await ms.pollDevice(dc, { signal: msAbort.signal }); } finally { msAbort = null; }
  const p = await ms.xboxChain(tok.access_token);
  msSet(p.uuid, { refresh: tok.refresh_token, mcToken: p.mcToken, mcExpires: p.mcExpires });
  settings.accounts = settings.accounts.filter((a) => !(a.type === 'microsoft' && a.uuid === p.uuid));
  settings.accounts.push({ type: 'microsoft', name: p.name, uuid: p.uuid, skinUrl: p.skinUrl, skinModel: p.model });
  settings.selected = settings.accounts.length - 1;
  save(); return publicState();
});
ipcMain.handle('ms:cancel', () => { if (msAbort) msAbort.abort(); });

async function ensureMsToken(acc) {
  const t = msGet(acc.uuid);
  if (!t) throw new Error('Сессия Microsoft не найдена — войдите заново');
  if (t.mcToken && t.mcExpires > Date.now() + 120000) return t.mcToken;
  if (!t.refresh) throw new Error('Сессия Microsoft истекла — войдите заново');
  const ms = msClient();
  const tok = await ms.refresh(t.refresh);
  const p = await ms.xboxChain(tok.access_token);
  msSet(acc.uuid, { refresh: tok.refresh_token || t.refresh, mcToken: p.mcToken, mcExpires: p.mcExpires });
  acc.name = p.name; acc.skinUrl = p.skinUrl; save();
  return p.mcToken;
}

// ---------- skins ----------
const STEVE = path.join(__dirname, 'renderer', 'assets', 'steve.png');
const toDataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');

ipcMain.handle('skin:get', async (_e, index) => {
  const acc = settings.accounts[index];
  if (!acc) return { dataUrl: toDataUrl(fs.readFileSync(STEVE)), model: 'classic', source: 'default' };
  if (acc.skinFile && fs.existsSync(acc.skinFile)) {
    return { dataUrl: toDataUrl(fs.readFileSync(acc.skinFile)), model: acc.skinModel || 'classic', source: 'custom' };
  }
  if (acc.type === 'microsoft' && acc.skinUrl) {
    try {
      const r = await fetch(acc.skinUrl, { headers: { 'User-Agent': UA } });
      if (r.ok) return { dataUrl: toDataUrl(Buffer.from(await r.arrayBuffer())), model: acc.skinModel || 'classic', source: 'microsoft' };
    } catch {}
  }
  if (acc.type === 'ely') {
    try {
      const r = await fetch(`http://skinsystem.ely.by/skins/${encodeURIComponent(acc.name)}.png`, { headers: { 'User-Agent': UA } });
      if (r.ok) return { dataUrl: toDataUrl(Buffer.from(await r.arrayBuffer())), model: acc.skinModel || 'classic', source: 'ely' };
    } catch {}
  }
  return { dataUrl: toDataUrl(fs.readFileSync(STEVE)), model: 'classic', source: 'default' };
});

ipcMain.handle('skin:upload', async (_e, index) => {
  const acc = settings.accounts[index];
  if (!acc) throw new Error('Нет аккаунта');
  if (acc.type === 'ely') throw new Error('Для Ely.by скин меняется на сайте ely.by');
  if (acc.type === 'microsoft') throw new Error('Для лицензионного аккаунта скин меняется на minecraft.net');
  const res = await dialog.showOpenDialog(win, { title: 'Выберите скин (PNG 64×64 или 64×32)', filters: [{ name: 'PNG', extensions: ['png'] }], properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return { ...publicState(), _changed: false };
  const buf = fs.readFileSync(res.filePaths[0]);
  supabaseMod.validateSkinPng(buf);                           // real PNG + size check, not just the extension
  if (acc.type === 'redshift') return rsGuard(async () => {
    // upload to Supabase Storage (same bucket/path as the website) and record it in profiles.skin_path
    const profile = await sb.getProfile();
    const skinPath = (profile && profile.skin_path) || sb.defaultSkinPath();
    await sb.uploadSkin(buf, skinPath);
    await sb.updateProfile({ skin_path: skinPath });
    fs.writeFileSync(rsSkinCache(acc.rsUserId), buf);
    acc.skinFile = rsSkinCache(acc.rsUserId);
    save(); return { ...publicState(), _changed: true };
  });
  const dest = path.join(SKINS, `${acc.uuid}.png`);
  fs.writeFileSync(dest, buf);
  acc.skinFile = dest;
  save(); return { ...publicState(), _changed: true };
});
ipcMain.handle('skin:reset', (_e, index) => {
  const acc = settings.accounts[index];
  if (acc && acc.type !== 'redshift' && acc.skinFile) { fs.rmSync(acc.skinFile, { force: true }); delete acc.skinFile; save(); }
  return publicState();
});
ipcMain.handle('skin:model', (_e, { index, model }) => {
  const acc = settings.accounts[index];
  if (acc) { acc.skinModel = model === 'slim' ? 'slim' : 'classic'; save(); }
  return publicState();
});

// ---------- versions & instances ----------
let manifestCache;
ipcMain.handle('versions:list', async () => {
  if (!manifestCache) manifestCache = await getJSON('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return manifestCache.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
});

function createInstance({ name, version, loader, loaderVersion }) {
  if (!LOADERS.includes(loader)) loader = 'vanilla';
  const id = (String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance') + '-' + Date.now().toString(36);
  const inst = { id, name, version, loader };
  if (loaderVersion) inst.loaderVersion = loaderVersion;
  settings.instances.push(inst);
  settings.selectedInstance = id;
  fs.mkdirSync(path.join(INSTANCES, id), { recursive: true });
  save();
  return inst;
}
ipcMain.handle('instance:create', (_e, { name, version, loader }) => {
  createInstance({ name, version, loader });
  return publicState();
});
ipcMain.handle('instance:delete', (_e, id) => {
  settings.instances = settings.instances.filter((i) => i.id !== id);
  if (settings.selectedInstance === id) settings.selectedInstance = settings.instances[0]?.id || null;
  fs.rmSync(path.join(INSTANCES, path.basename(id)), { recursive: true, force: true });
  save(); return publicState();
});
const getInst = (id) => {
  const i = settings.instances.find((x) => x.id === id);
  if (!i) throw new Error('Выберите сборку');
  return i;
};

// ---------- Java ----------
function javaMajorFor(mc) {
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21; // snapshots / year-based versions
  const minor = +m[1], patch = +(m[2] || 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17; // 1.17 needs Java 16+, 17 works for 1.17-1.20.4
  return 8;
}
function findJavaExe(dir) {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === exe && path.basename(d) === 'bin') return p;
    }
  }
  return null;
}
async function ensureJava(mc) {
  if (settings.javaPath && fs.existsSync(settings.javaPath)) return settings.javaPath;
  const major = javaMajorFor(mc);
  const dir = path.join(JAVA_DIR, String(major));
  if (fs.existsSync(dir)) { const f = findJavaExe(dir); if (f) return f; }
  send('progress', { text: `Скачиваю Java ${major}…`, percent: 0 });
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${plat}/${arch}/jre/hotspot/normal/eclipse`;
  const tmp = path.join(TMP, `java-${major}.${plat === 'windows' ? 'zip' : 'tar.gz'}`);
  await download(url, tmp);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (plat === 'windows') new AdmZip(tmp).extractAllTo(dir, true);
  else spawnSync('tar', ['-xzf', tmp, '-C', dir]);
  fs.rmSync(tmp, { force: true });
  const exe = findJavaExe(dir);
  if (!exe) throw new Error('Не удалось установить Java');
  return exe;
}
// the Forge installer wants console java (java.exe), the game itself uses javaw.exe
function consoleJava(p) {
  if (/javaw\.exe$/i.test(p)) { const c = p.replace(/javaw\.exe$/i, 'java.exe'); if (fs.existsSync(c)) return c; }
  return p;
}

// ---------- launch ----------
let running = null;
ipcMain.handle('game:launch', async (_e, instanceId) => {
  if (running) throw new Error('Игра уже запущена');
  const inst = getInst(instanceId);
  const acc = settings.accounts[settings.selected];
  if (!acc) throw new Error('Добавьте аккаунт (REDSHIFT ID, Microsoft, Ely.by или оффлайн)');

  send('progress', { text: 'Подготовка…', percent: 0 });
  const javaPath = await ensureJava(inst.version);
  const gameDir = path.join(INSTANCES, inst.id);
  const { args: jvm, fixedHeap } = perf.jvmArgs(settings);
  const customArgs = [...jvm];

  let authorization = {
    access_token: 'offline', client_token: 'offline', uuid: acc.uuid, name: acc.name,
    user_properties: '{}', meta: { type: 'mojang', demo: false }
  };
  if (acc.type === 'ely') {
    send('progress', { text: 'Проверка сессии Ely.by…', percent: 0 });
    await ensureElyToken(acc);
    const jar = await ensureAuthlib();
    customArgs.push(`-javaagent:${jar}=ely.by`);   // Ely.by shorthand supported by authlib-injector
    authorization = { ...authorization, access_token: acc.accessToken, client_token: acc.clientToken };
  } else if (acc.type === 'microsoft') {
    send('progress', { text: 'Проверка сессии Microsoft…', percent: 0 });
    const mcToken = await ensureMsToken(acc);
    authorization = {
      access_token: mcToken, client_token: crypto.randomUUID().replace(/-/g, ''), uuid: acc.uuid, name: acc.name,
      user_properties: '{}', meta: { type: 'msa', demo: false }
    };
  } else if (acc.skinFile && fs.existsSync(acc.skinFile)) {
    send('progress', { text: 'Подключаю свой скин…', percent: 0 });
    const port = await skinServer.start();
    skinServer.setProfile(acc.uuid, acc.name, acc.skinFile, acc.skinModel);
    const jar = await ensureAuthlib();
    customArgs.push(`-javaagent:${jar}=http://127.0.0.1:${port}`);
  }

  const version = { number: inst.version, type: 'release' };
  if (inst.loader !== 'vanilla') {
    send('progress', { text: `Установка загрузчика (${inst.loader})…`, percent: 0 });
    version.custom = await installLoader({
      kind: inst.loader, mc: inst.version, root: ROOT, javaExe: consoleJava(javaPath),
      send, getJSON, download, tmpDir: TMP, pin: inst.loaderVersion
    });
    if (inst.versionId !== version.custom) { inst.versionId = version.custom; save(); }
  }

  if (settings.autoVideo && !inst.tuned) {
    try { perf.applyVideoTweaks(gameDir, settings.videoLevel); inst.tuned = true; save(); } catch {}
  }

  const launcher = new Client();
  launcher.on('progress', (p) => send('progress', { text: `Загрузка файлов: ${p.type}`, percent: p.total ? Math.round((p.task / p.total) * 100) : 0 }));
  launcher.on('debug', (m) => send('log', m));
  launcher.on('data', (m) => send('log', String(m)));
  launcher.on('close', (code) => {
    running = null;
    send('game:closed', code);
    if (settings.behavior === 'minimize' && win && !win.isDestroyed()) { win.restore(); win.focus(); }
  });

  const opts = {
    authorization,
    root: ROOT,
    javaPath,
    version,
    memory: { max: `${settings.ram}M`, min: fixedHeap ? `${settings.ram}M` : '512M' },
    customArgs,
    overrides: { gameDirectory: gameDir }
  };
  if (settings.fullscreen) opts.window = { fullscreen: true };
  else if (settings.width > 0 && settings.height > 0) opts.window = { width: settings.width, height: settings.height };

  const proc = await launcher.launch(opts);
  if (!proc) throw new Error('Не удалось запустить игру — смотрите журнал');
  running = proc;
  send('progress', { text: 'Игра запущена', percent: 100 });
  if (settings.behavior === 'minimize' && win) setTimeout(() => win && !win.isDestroyed() && win.minimize(), 1500);
  return true;
});
ipcMain.handle('game:kill', () => { running?.kill(); });

// ---------- Modrinth ----------
const MR = 'https://api.modrinth.com/v2';
const MR_TYPE = { mod: 'mod', resourcepack: 'resourcepack', shader: 'shader' };
const FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };

async function mrInstall(idOrSlug, kind, inst, seen = new Set()) {
  if (seen.has(idOrSlug)) return null;
  seen.add(idOrSlug);
  const q = new URLSearchParams({ game_versions: JSON.stringify([inst.version]) });
  if (kind === 'mod' && inst.loader !== 'vanilla') q.set('loaders', JSON.stringify(modLoaders(inst.loader)));
  const versions = await getJSON(`${MR}/project/${idOrSlug}/version?${q}`);
  if (!versions.length) throw new Error('Нет подходящей версии для этой сборки');
  const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
  await download(file.url, path.join(INSTANCES, inst.id, FOLDER[kind], file.filename));
  for (const dep of versions[0].dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    try { await mrInstall(dep.project_id, kind, inst, seen); } catch {}
  }
  return file.filename;
}

ipcMain.handle('modrinth:search', async (_e, { query, kind, instanceId, offset }) => {
  const inst = settings.instances.find((i) => i.id === instanceId);
  const facets = [[`project_type:${MR_TYPE[kind]}`]];
  if (inst) facets.push([`versions:${inst.version}`]);
  if (inst && kind === 'mod' && inst.loader !== 'vanilla') facets.push(modLoaders(inst.loader).map((l) => `categories:${l}`));
  const u = `${MR}/search?query=${encodeURIComponent(query || '')}&limit=20&offset=${offset || 0}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const d = await getJSON(u);
  return d.hits.map((h) => ({
    source: 'modrinth', id: h.project_id, title: h.title, author: h.author, description: h.description,
    icon: h.icon_url, downloads: h.downloads
  }));
});
ipcMain.handle('modrinth:install', (_e, { id, kind, instanceId }) => mrInstall(id, kind, getInst(instanceId)));

// ---------- CurseForge ----------
const CF = 'https://api.curseforge.com/v1';
const CF_CLASS = { mod: 6, resourcepack: 12, shader: 6552 };
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const cfHeaders = () => {
  if (!settings.cfKey) throw new Error('Укажите API-ключ CurseForge в настройках (console.curseforge.com)');
  return { 'x-api-key': settings.cfKey, Accept: 'application/json' };
};
ipcMain.handle('curseforge:search', async (_e, { query, kind, instanceId, offset }) => {
  const inst = settings.instances.find((i) => i.id === instanceId);
  const p = new URLSearchParams({
    gameId: '432', classId: String(CF_CLASS[kind]), searchFilter: query || '',
    sortField: '2', sortOrder: 'desc', pageSize: '20', index: String(offset || 0)
  });
  if (inst) p.set('gameVersion', inst.version);
  if (inst && kind === 'mod' && CF_LOADER[inst.loader]) p.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const d = await getJSON(`${CF}/mods/search?${p}`, { headers: cfHeaders() });
  return d.data.map((m) => ({
    source: 'curseforge', id: String(m.id), title: m.name, author: m.authors?.[0]?.name || '',
    description: m.summary, icon: m.logo?.thumbnailUrl, downloads: m.downloadCount
  }));
});
ipcMain.handle('curseforge:install', async (_e, { id, kind, instanceId }) => {
  const inst = getInst(instanceId);
  const p = new URLSearchParams({ gameVersion: inst.version, pageSize: '10' });
  if (kind === 'mod' && CF_LOADER[inst.loader]) p.set('modLoaderType', String(CF_LOADER[inst.loader]));
  const d = await getJSON(`${CF}/mods/${id}/files?${p}`, { headers: cfHeaders() });
  const f = d.data.find((x) => x.downloadUrl) || d.data[0];
  if (!f) throw new Error('Нет подходящего файла для этой сборки');
  if (!f.downloadUrl) throw new Error('Автор запретил скачивание вне сайта CurseForge');
  await download(f.downloadUrl, path.join(INSTANCES, inst.id, FOLDER[kind], f.fileName));
  return f.fileName;
});

// ---------- installed content ----------
ipcMain.handle('mods:installed', (_e, { instanceId, kind }) => {
  const inst = getInst(instanceId);
  const dir = path.join(INSTANCES, inst.id, FOLDER[kind]);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ file: e.name, size: fs.statSync(path.join(dir, e.name)).size }))
    .sort((a, b) => a.file.localeCompare(b.file));
});
ipcMain.handle('mods:remove', (_e, { instanceId, kind, file }) => {
  const inst = getInst(instanceId);
  fs.rmSync(path.join(INSTANCES, inst.id, FOLDER[kind], path.basename(file)), { force: true });
  return true;
});

// ---------- performance ----------
ipcMain.handle('perf:optimize', async (_e, instanceId) => {
  const inst = getInst(instanceId);
  const gameDir = path.join(INSTANCES, inst.id);
  const ok = [], failed = [];
  const list = perf.FPS_MODS[inst.loader] || [];
  let i = 0;
  for (const slug of list) {
    send('progress', { text: `FPS-моды: ${slug}`, percent: Math.round((i++ / list.length) * 100) });
    try { await mrInstall(slug, 'mod', inst); ok.push(slug); } catch { failed.push(slug); }
  }
  perf.applyVideoTweaks(gameDir, settings.videoLevel);
  inst.tuned = true; save();
  send('progress', { text: 'Оптимизация завершена', percent: 100 });
  return { ok, failed, mods: list.length > 0 };
});

// ---------- modpacks ----------
async function postJSON(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}
const modpacks = modpacksModule.create({
  instancesDir: INSTANCES, tmpDir: TMP, getJSON, download, send, postJSON,
  createInstance, cfHeaders: () => cfHeaders(),
  removeInstance: (inst) => {
    settings.instances = settings.instances.filter((i) => i.id !== inst.id);
    if (settings.selectedInstance === inst.id) settings.selectedInstance = settings.instances[0]?.id || null;
    fs.rmSync(path.join(INSTANCES, path.basename(inst.id)), { recursive: true, force: true });
    save();
  }
});
ipcMain.handle('packs:search', (_e, { source, query, offset }) =>
  source === 'curseforge' ? modpacks.searchCurseForge({ query, offset }) : modpacks.searchModrinth({ query, offset }));
ipcMain.handle('packs:install', async (_e, { source, id }) => {
  const inst = source === 'curseforge' ? await modpacks.installCurseForge(id) : await modpacks.installModrinth(id);
  send('progress', { text: `Модпак «${inst.name}» установлен`, percent: 100 });
  return { state: publicState(), name: inst.name, missing: inst.missing || [] };
});
ipcMain.handle('packs:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите модпак', properties: ['openFile'],
    filters: [{ name: 'Модпаки (.mrpack, .zip)', extensions: ['mrpack', 'zip'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const inst = await modpacks.installFromFile(res.filePaths[0]);
  send('progress', { text: `Модпак «${inst.name}» импортирован`, percent: 100 });
  return { state: publicState(), name: inst.name, missing: inst.missing || [] };
});
ipcMain.handle('packs:export', async (_e, { instanceId, saves }) => {
  const inst = getInst(instanceId);
  const res = await dialog.showSaveDialog(win, {
    title: 'Экспорт сборки', defaultPath: `${inst.name}.mrpack`,
    filters: [{ name: 'Modrinth modpack (.mrpack)', extensions: ['mrpack'] }]
  });
  if (res.canceled || !res.filePath) return null;
  const r = modpacks.exportMrpack(inst, res.filePath, { saves: !!saves });
  return { file: res.filePath, size: r.size };
});
