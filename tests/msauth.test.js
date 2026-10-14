const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/msauth');

// scripted fetch: routes by URL, records calls
function script(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, body: opts.body, headers: opts.headers });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error('unexpected ' + url);
    let r = routes[key]; if (typeof r === 'function') r = r(opts, calls);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls; return fn;
}
const ok = (body) => ({ status: 200, body });
const happy = () => ({
  'https://user.auth.xboxlive.com/user/authenticate': ok({ Token: 'XBL', DisplayClaims: { xui: [{ uhs: 'UHS1' }] } }),
  'https://xsts.auth.xboxlive.com/xsts/authorize': ok({ Token: 'XSTS' }),
  'https://api.minecraftservices.com/authentication/login_with_xbox': ok({ access_token: 'MCTOKEN', expires_in: 86400 }),
  'https://api.minecraftservices.com/minecraft/profile': ok({ id: 'abcdef0123456789abcdef0123456789', name: 'Notch', skins: [{ state: 'ACTIVE', url: 'http://t/skin', variant: 'SLIM' }] })
});

test('full chain: tokens are passed correctly and profile returned', async () => {
  const f = script(happy());
  const p = await create({ clientId: 'cid', fetchFn: f }).xboxChain('MSTOKEN');
  assert.equal(p.name, 'Notch'); assert.equal(p.uuid, 'abcdef0123456789abcdef0123456789'); assert.equal(p.mcToken, 'MCTOKEN');
  assert.equal(p.model, 'slim'); assert.equal(p.skinUrl, 'http://t/skin');
  assert.equal(JSON.parse(f.calls[0].body).Properties.RpsTicket, 'd=MSTOKEN');
  assert.deepEqual(JSON.parse(f.calls[1].body).Properties.UserTokens, ['XBL']);
  assert.equal(JSON.parse(f.calls[2].body).identityToken, 'XBL3.0 x=UHS1;XSTS');
});

test('no Minecraft license (profile 404) gives a clear message', async () => {
  const r = happy(); r['https://api.minecraftservices.com/minecraft/profile'] = { status: 404, body: {} };
  await assert.rejects(create({ clientId: 'c', fetchFn: script(r) }).xboxChain('t'), (e) => e.code === 'no_license');
});

test('Xbox errors are translated (no Xbox profile, child account)', async () => {
  for (const [x, re] of [[2148916233, /нет профиля Xbox/], [2148916238, /Детская/]]) {
    const r = happy(); r['https://xsts.auth.xboxlive.com/xsts/authorize'] = { status: 401, body: { XErr: x } };
    await assert.rejects(create({ clientId: 'c', fetchFn: script(r) }).xboxChain('t'), (e) => re.test(e.message));
  }
});

test('device code flow: waits through pending, slow_down, then returns tokens', async () => {
  let n = 0;
  const f = script({
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode': ok({ user_code: 'ABCD', device_code: 'DC', verification_uri: 'https://microsoft.com/link', interval: 1, expires_in: 900 }),
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token': () => { n++; return n === 1 ? { status: 400, body: { error: 'authorization_pending' } } : n === 2 ? { status: 400, body: { error: 'slow_down' } } : ok({ access_token: 'A', refresh_token: 'R' }); }
  });
  const ms = create({ clientId: 'cid', fetchFn: f });
  const dc = await ms.deviceCode(); assert.equal(dc.user_code, 'ABCD');
  const waits = [];
  const tok = await ms.pollDevice(dc, { sleep: async (m) => { waits.push(m); } });
  assert.equal(tok.refresh_token, 'R'); assert.deepEqual(waits, [1000, 1000, 6000]);
});

test('declined / expired / cancelled / missing client id / refresh failure', async () => {
  const route = (err) => ({ 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token': { status: 400, body: { error: err } } });
  const dc = { device_code: 'x', interval: 1, expires_in: 900 };
  await assert.rejects(create({ clientId: 'c', fetchFn: script(route('authorization_declined')) }).pollDevice(dc, { sleep: async () => {} }), (e) => e.code === 'declined');
  await assert.rejects(create({ clientId: 'c', fetchFn: script(route('expired_token')) }).pollDevice(dc, { sleep: async () => {} }), (e) => e.code === 'expired');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(create({ clientId: 'c', fetchFn: script(route('authorization_pending')) }).pollDevice(dc, { sleep: async () => {}, signal: ac.signal }), (e) => e.code === 'cancelled');
  await assert.rejects(create({ clientId: '', fetchFn: script({}) }).deviceCode(), (e) => e.code === 'no_client');
  await assert.rejects(create({ clientId: 'c', fetchFn: script(route('invalid_grant')) }).refresh('old'), (e) => e.code === 'refresh');
});

test('network failure is reported as such', async () => {
  const f = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(create({ clientId: 'c', fetchFn: f }).deviceCode(), (e) => e.code === 'network');
});
