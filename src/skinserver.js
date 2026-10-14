// Tiny local Yggdrasil-compatible server used with authlib-injector so that an
// OFFLINE account can show a custom skin in the game.
// Only the endpoints needed for skin loading are implemented.
const http = require('http');
const fs = require('fs');

let server = null;
let port = 0;
const profiles = new Map(); // uuid -> { name, file, model }

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/' || p === '') {
    return json(res, 200, {
      meta: { serverName: 'Redshift Local Skins', implementationName: 'redshift-launcher', implementationVersion: '1.0' },
      skinDomains: ['127.0.0.1', 'localhost']
    });
  }

  const m = p.match(/^\/sessionserver\/session\/minecraft\/profile\/([0-9a-fA-F-]+)$/);
  if (m) {
    const uuid = m[1].replace(/-/g, '').toLowerCase();
    const prof = profiles.get(uuid);
    if (!prof) { res.writeHead(204); return res.end(); }
    const skin = { url: `http://127.0.0.1:${port}/textures/${uuid}.png` };
    if (prof.model === 'slim') skin.metadata = { model: 'slim' };
    const payload = { timestamp: Date.now(), profileId: uuid, profileName: prof.name, textures: { SKIN: skin } };
    return json(res, 200, {
      id: uuid,
      name: prof.name,
      properties: [{ name: 'textures', value: Buffer.from(JSON.stringify(payload)).toString('base64') }]
    });
  }

  const t = p.match(/^\/textures\/([0-9a-fA-F]+)\.png$/);
  if (t) {
    const prof = profiles.get(t[1].toLowerCase());
    if (!prof || !fs.existsSync(prof.file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return fs.createReadStream(prof.file).pipe(res);
  }

  // anything else: empty answer so the game just carries on
  res.writeHead(404); res.end();
}

function start() {
  return new Promise((resolve, reject) => {
    if (server) return resolve(port);
    server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

function setProfile(uuid, name, file, model) {
  profiles.set(uuid.replace(/-/g, '').toLowerCase(), { name, file, model });
}

function stop() { if (server) { server.close(); server = null; } }

module.exports = { start, setProfile, stop };
