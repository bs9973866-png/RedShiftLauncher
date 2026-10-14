// Microsoft (licensed Minecraft: Java Edition) sign-in.
//
// NOTE: this file was re-created after being overwritten by mistake; it keeps the API main.js expects:
//   create({ clientId }) -> { deviceCode(), pollDevice(dc, { signal }), refresh(refreshToken), xboxChain(msAccessToken) }
//
// Flow: Microsoft device code -> Xbox Live -> XSTS -> Minecraft services -> ownership check + profile.
// Needs an Azure AD application (client) ID with "Allow public client flows" enabled; the application must
// also be approved for the Minecraft services API by Mojang (https://aka.ms/AppRegInfo).
const MS_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const URLS = {
  deviceCode: `${MS_BASE}/devicecode`,
  token: `${MS_BASE}/token`,
  xblAuth: 'https://user.auth.xboxlive.com/user/authenticate',
  xstsAuth: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  mcProfile: 'https://api.minecraftservices.com/minecraft/profile'
};
const SCOPE = 'XboxLive.signin offline_access';

class MsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const XSTS_ERRORS = {
  2148916233: 'У этой учётной записи Microsoft нет профиля Xbox. Создайте его на xbox.com и повторите вход',
  2148916235: 'Xbox Live недоступен в вашей стране',
  2148916236: 'Для этой учётной записи нужна проверка возраста на xbox.com',
  2148916237: 'Для этой учётной записи нужна проверка возраста на xbox.com',
  2148916238: 'Детской учётной записи нужно разрешение родителя в семейной группе Microsoft'
};

function create({ clientId, fetchImpl = fetch, urls = URLS, sleep, now = () => Date.now() } = {}) {
  const wait = sleep || ((ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new MsError('cancelled', 'Вход отменён')); }, { once: true });
  }));

  const needId = () => {
    if (!clientId) throw new MsError('config', 'Не задан Client ID приложения Microsoft. Откройте Настройки → Основные → «Microsoft Client ID» (см. README)');
    return clientId;
  };

  async function request(url, { method = 'POST', json, form, token, signal } = {}) {
    const headers = { Accept: 'application/json' };
    const opts = { method, headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) };
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString(); }
    else if (json) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (token) headers.Authorization = `Bearer ${token}`;
    let r;
    try { r = await fetchImpl(url, opts); }
    catch (e) {
      if (signal && signal.aborted) throw new MsError('cancelled', 'Вход отменён');
      throw new MsError('network', 'Нет соединения с серверами Microsoft / Minecraft');
    }
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    return { r, body };
  }

  // 1) ask Microsoft for a code the user types at microsoft.com/link
  async function deviceCode() {
    const { r, body } = await request(urls.deviceCode, { form: { client_id: needId(), scope: SCOPE } });
    if (!r.ok) throw new MsError('config', `Microsoft отклонил приложение: ${body.error_description || body.error || r.status}`);
    return { ...body, _expiresAt: now() + (Number(body.expires_in) || 900) * 1000 };
  }

  // 2) wait until the user confirms in the browser; resolves with { access_token, refresh_token }
  async function pollDevice(dc, { signal } = {}) {
    let interval = Number(dc.interval) || 5;
    const deadline = dc._expiresAt || now() + (Number(dc.expires_in) || 900) * 1000;
    while (now() < deadline) {
      if (signal && signal.aborted) throw new MsError('cancelled', 'Вход отменён');
      await wait(interval * 1000, signal);
      const { r, body } = await request(urls.token, { signal, form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: needId(), device_code: dc.device_code
      } });
      if (r.ok) return body;
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') { interval += 5; continue; }
      if (body.error === 'authorization_declined') throw new MsError('declined', 'Вход отклонён в браузере');
      if (body.error === 'expired_token') break;
      throw new MsError('auth', body.error_description || body.error || 'Ошибка входа Microsoft');
    }
    throw new MsError('expired', 'Время на вход вышло. Нажмите «Войти через Microsoft» ещё раз');
  }

  async function refresh(refreshToken) {
    const { r, body } = await request(urls.token, { form: { grant_type: 'refresh_token', client_id: needId(), refresh_token: refreshToken, scope: SCOPE } });
    if (!r.ok) throw new MsError('session_expired', 'Сессия Microsoft истекла. Войдите заново');
    return body;                                   // { access_token, refresh_token }
  }

  // 3) Microsoft access token -> Xbox -> XSTS -> Minecraft token + profile
  async function xboxChain(msAccessToken) {
    let x = await request(urls.xblAuth, { json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
    } });
    if (!x.r.ok || !x.body.Token) throw new MsError('xbox', 'Не удалось войти в Xbox Live');
    const xbl = x.body.Token;

    x = await request(urls.xstsAuth, { json: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
    } });
    if (!x.r.ok) throw new MsError('xsts', XSTS_ERRORS[x.body.XErr] || 'Xbox не выдал разрешение для Minecraft');
    const xsts = x.body.Token;
    const uhs = x.body.DisplayClaims && x.body.DisplayClaims.xui && x.body.DisplayClaims.xui[0] && x.body.DisplayClaims.xui[0].uhs;
    if (!xsts || !uhs) throw new MsError('xsts', 'Xbox вернул неполный ответ');

    const mc = await request(urls.mcLogin, { json: { identityToken: `XBL3.0 x=${uhs};${xsts}` } });
    if (!mc.r.ok || !mc.body.access_token) {
      if (mc.r.status === 403) throw new MsError('app_not_approved', 'Minecraft отклонил приложение (403). Приложению нужно одобрение Mojang: https://aka.ms/AppRegInfo');
      throw new MsError('minecraft', 'Не удалось войти в Minecraft');
    }
    const mcToken = mc.body.access_token;
    const mcExpires = now() + (Number(mc.body.expires_in) || 86400) * 1000;

    // 4) ownership: a Microsoft account without a Java licence has no Minecraft profile (404)
    const pr = await request(urls.mcProfile, { method: 'GET', token: mcToken });
    if (pr.r.status === 404) throw new MsError('no_game', 'На этой учётной записи Microsoft нет лицензии Minecraft: Java Edition');
    if (!pr.r.ok || !pr.body.id) throw new MsError('minecraft', 'Не удалось получить профиль Minecraft');
    const skin = (pr.body.skins || []).find((s) => s.state === 'ACTIVE') || (pr.body.skins || [])[0];
    return {
      uuid: pr.body.id, name: pr.body.name, skinUrl: skin && skin.url,
      model: skin && skin.variant === 'SLIM' ? 'slim' : 'classic', mcToken, mcExpires
    };
  }

  return { deviceCode, pollDevice, refresh, xboxChain };
}

module.exports = { create, MsError, URLS };
