// Minimal Supabase client for the launcher (talks to the documented REST endpoints of
// GoTrue / PostgREST / Storage). Uses ONLY the publishable key; all access is governed by RLS.
// Tokens are never logged and never leave the main process.

class RsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Real PNG check (signature + IHDR + Minecraft skin sizes); the file extension is not trusted.
function validateSkinPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new RsError('bad_png', 'Это не PNG-файл');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new RsError('bad_png', 'Повреждённый PNG-файл');
  if (buf.length > 1024 * 1024) throw new RsError('bad_png', 'Файл слишком большой (максимум 1 МБ)');
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') throw new RsError('bad_png', 'Повреждённый PNG-файл (обрезан)');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== 64 || (h !== 64 && h !== 32)) throw new RsError('bad_size', `Нужен скин 64×64 или 64×32, а у файла ${w}×${h}`);
  return { width: w, height: h };
}

function create({ url, key, bucket = 'skins', skinPathTemplate = '{uid}/skin.png', fetchFn, store, now } = {}) {
  const f = fetchFn || ((...a) => fetch(...a));
  const nowMs = now || Date.now;
  const base = String(url || '').replace(/\/+$/, '');
  let apiKey = key || '';
  let session = null;
  let refreshing = null;

  // ----- session persistence -----
  function persist() { try { store && store.save(session); } catch { /* storage is best effort */ } }
  function drop() { session = null; try { store && store.clear(); } catch { /* ignore */ } }
  function setSession(b) {
    const user = b.user || (session && session.user) || {};
    session = {
      access_token: b.access_token,
      refresh_token: b.refresh_token || (session && session.refresh_token),
      expires_at: b.expires_at || Math.floor(nowMs() / 1000) + (b.expires_in || 3600),
      user: { id: user.id, email: user.email }
    };
    persist();
  }

  // ----- low level -----
  function needKey() {
    if (!apiKey) throw new RsError('no_key', 'Не задан Supabase Publishable Key (Настройки → Основные)');
  }
  async function raw(path, opts = {}) {
    needKey();
    try {
      return await f(base + path, {
        signal: AbortSignal.timeout(20000),
        ...opts,
        headers: { apikey: apiKey, ...(opts.headers || {}) }
      });
    } catch {
      throw new RsError('network', 'Нет соединения с сервером REDSHIFT');
    }
  }
  const readJSON = async (r) => { try { return await r.json(); } catch { return {}; } };
  const errMsg = (b) => String(b.msg || b.error_description || b.message || b.error || '');
  const errCode = (b) => String(b.error_code || b.code || '');

  function mapAuthError(status, b) {
    const code = errCode(b), msg = errMsg(b);
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg))
      return new RsError('email_not_confirmed', 'Почта не подтверждена. Откройте письмо от REDSHIFT, перейдите по ссылке и войдите снова.');
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return new RsError('invalid_credentials', 'Неверная почта или пароль.');
    if (status === 429 || /rate limit/i.test(code + msg)) return new RsError('rate_limit', 'Слишком много попыток. Подождите минуту и повторите.');
    if (code === 'user_banned' || /banned/i.test(msg)) return new RsError('banned', 'Этот аккаунт заблокирован.');
    if (/invalid api key|no api key/i.test(msg)) return new RsError('bad_key', 'Неверный Supabase Publishable Key — проверьте Настройки.');
    return new RsError('auth', `Не удалось войти${msg ? ': ' + msg : ''}`);
  }
  function mapRestError(status, b, what) {
    const code = errCode(b), msg = errMsg(b);
    if (code === '23505' || /duplicate key|already exists/i.test(msg)) return new RsError('taken', 'Этот ник уже занят.');
    if (status === 401 || status === 403 || code === '42501' || /row-level security|permission denied/i.test(msg))
      return new RsError('forbidden', `Нет прав: ${what} (политики доступа Supabase RLS).`);
    if (status === 404) return new RsError('not_found', `${what}: не найдено (проверьте схему базы).`);
    return new RsError('server', `${what}: ошибка сервера (${status})${msg ? ' — ' + msg : ''}`);
  }

  // ----- auth -----
  async function signIn(email, password) {
    needKey();
    const r = await raw('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim(), password })
    });
    const b = await readJSON(r);
    if (!r.ok) throw mapAuthError(r.status, b);
    session = null;
    setSession(b);
    return info();
  }

  function refreshSession() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!session || !session.refresh_token) throw new RsError('not_logged_in', 'Войдите в аккаунт REDSHIFT');
      const r = await raw('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      const b = await readJSON(r);
      if (!r.ok) {
        // 4xx = the refresh token is dead; 5xx = server trouble, keep the session for later
        if (r.status >= 400 && r.status < 500) { drop(); throw new RsError('session_expired', 'Сессия истекла — войдите снова.'); }
        throw new RsError('server', 'Сервер REDSHIFT временно недоступен');
      }
      setSession(b);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function token() {
    if (!session) throw new RsError('not_logged_in', 'Войдите в аккаунт REDSHIFT');
    if (session.expires_at - 60 <= nowMs() / 1000) await refreshSession();
    return session.access_token;
  }

  // authenticated request with one automatic retry after a refresh on 401
  async function authed(path, opts = {}) {
    const run = async () => raw(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + (await token()) } });
    let r = await run();
    if (r.status === 401 && session) { await refreshSession(); r = await run(); }
    return r;
  }

  async function signOut() {
    const s = session;
    drop();
    if (s && apiKey) {
      try { await f(base + '/auth/v1/logout', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { apikey: apiKey, Authorization: 'Bearer ' + s.access_token } }); }
      catch { /* offline logout is fine: the local session is already gone */ }
    }
  }

  // restore a saved session at startup
  async function init() {
    if (session) return info();
    let saved = null;
    try { saved = store && store.load(); } catch { saved = null; }
    if (saved && saved.access_token && saved.refresh_token && saved.user && saved.user.id) {
      session = saved;
      try { await token(); } catch (e) { if (e.code === 'session_expired') return info(); /* network: keep the saved session */ }
    }
    return info();
  }

  // ----- profile (table public.profiles: id, username, skin_path, updated_at) -----
  const uid = () => { if (!session) throw new RsError('not_logged_in', 'Войдите в аккаунт REDSHIFT'); return session.user.id; };

  async function getProfile() {
    const id = uid();
    const r = await authed(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,username,skin_path,updated_at`, { headers: { Accept: 'application/json' } });
    const b = await readJSON(r);
    if (!r.ok) throw mapRestError(r.status, b, 'Загрузка профиля');
    return Array.isArray(b) && b[0] ? b[0] : null;
  }

  async function updateProfile(patch) {
    const id = uid();
    const body = { updated_at: new Date(nowMs()).toISOString() };
    if ('username' in patch) body.username = patch.username;
    if ('skin_path' in patch) body.skin_path = patch.skin_path;
    const H = { 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation' };
    let r = await authed(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
    let b = await readJSON(r);
    if (!r.ok && (errCode(b) === 'PGRST204' || /updated_at/.test(errMsg(b)))) {   // this schema has no updated_at column
      delete body.updated_at;
      r = await authed(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
      b = await readJSON(r);
    }
    if (!r.ok) throw mapRestError(r.status, b, 'Сохранение профиля');
    if (Array.isArray(b) && b.length === 0) {                       // no row yet -> create it (id is always our own)
      r = await authed('/rest/v1/profiles', { method: 'POST', headers: H, body: JSON.stringify({ id, ...body }) });
      b = await readJSON(r);
      if (!r.ok) throw mapRestError(r.status, b, 'Создание профиля');
    }
    return Array.isArray(b) ? b[0] : b;
  }

  // ----- skins (Storage bucket) -----
  function safePath(p) {
    if (!p || typeof p !== 'string' || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '')) throw new RsError('bad_path', 'Некорректный путь к скину');
    return p.split('/').map(encodeURIComponent).join('/');
  }
  function defaultSkinPath() { return skinPathTemplate.replace('{uid}', uid()); }

  async function downloadSkin(skinPath) {
    let r = await authed(`/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${safePath(skinPath)}`);
    if (r.status === 404 || r.status === 400) {
      // a PUBLIC bucket is served without RLS through the public route: try it before giving up
      r = await raw(`/storage/v1/object/public/${encodeURIComponent(bucket)}/${safePath(skinPath)}`);
    }
    if (r.status === 404 || r.status === 400) return null;           // missing file (Storage answers 400/404)
    if (!r.ok) throw mapRestError(r.status, await readJSON(r), 'Загрузка скина');
    return Buffer.from(await r.arrayBuffer());
  }

  async function uploadSkin(buf, skinPath) {
    validateSkinPng(buf);
    const id = uid();
    const safe = safePath(skinPath);
    if (!skinPath.startsWith(id + '/') && !skinPath.startsWith(id + '.')) {
      throw new RsError('forbidden', 'Путь скина не принадлежит вашему аккаунту — загрузка отменена.');
    }
    const r = await authed(`/storage/v1/object/${encodeURIComponent(bucket)}/${safe}`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', 'x-upsert': 'true', 'Cache-Control': '3600' }, body: buf
    });
    if (!r.ok) throw mapRestError(r.status, await readJSON(r), 'Загрузка скина в хранилище');
    return skinPath;
  }

  const info = () => ({ loggedIn: !!session, email: session ? session.user.email : '', userId: session ? session.user.id : '', hasKey: !!apiKey });

  return {
    init, signIn, signOut, refreshSession, getProfile, updateProfile, downloadSkin, uploadSkin,
    defaultSkinPath, info, setKey(k) { apiKey = k || ''; }, getSession: () => session
  };
}

module.exports = { create, validateSkinPng, RsError };
