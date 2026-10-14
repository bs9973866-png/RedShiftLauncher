// Modpack support: install from Modrinth (.mrpack) and CurseForge (manifest.json zip),
// import from a local file, export an instance as .mrpack.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { loaderVersionFromId } = require('./loaders');

const MR = 'https://api.modrinth.com/v2';
const CF = 'https://api.curseforge.com/v1';
const CF_PACK_CLASS = 4471;
const CF_FOLDER = { 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks', 17: 'saves' };

// ----- helpers -----
function safeJoin(base, rel) {
  const dest = path.resolve(base, rel);
  if (dest !== path.resolve(base) && !dest.startsWith(path.resolve(base) + path.sep)) {
    throw new Error('Небезопасный путь в модпаке: ' + rel);
  }
  return dest;
}

function extractFolder(zip, prefixes, destDir) {
  let n = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (!prefix) continue;
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    const dest = safeJoin(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
    n++;
  }
  return n;
}

async function pool(items, limit, worker) {
  let i = 0, done = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return done;
}

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

// ----- the module -----
// ctx: { instancesDir, tmpDir, getJSON, download, send, createInstance(info), cfHeaders(), postJSON(url, body, headers) }
function create(ctx) {
  const { instancesDir, tmpDir, getJSON, download, send } = ctx;
  const progress = (text, percent) => send('progress', { text, percent });

  // ---------- Modrinth format ----------
  async function installMrpack(zip, fallbackName) {
    const entry = zip.getEntry('modrinth.index.json');
    const index = JSON.parse(entry.getData().toString('utf8'));
    const deps = index.dependencies || {};
    const mc = deps.minecraft;
    if (!mc) throw new Error('В модпаке не указана версия Minecraft');
    let loader = 'vanilla', loaderVersion = '';
    for (const [k, l] of [['fabric-loader', 'fabric'], ['quilt-loader', 'quilt'], ['neoforge', 'neoforge'], ['forge', 'forge']]) {
      if (deps[k]) { loader = l; loaderVersion = deps[k]; break; }
    }
    const inst = ctx.createInstance({ name: index.name || fallbackName || 'Модпак', version: mc, loader, loaderVersion });
    const dir = path.join(instancesDir, inst.id);
    try {
    const files = (index.files || []).filter((f) => !(f.env && f.env.client === 'unsupported'));
    progress(`Скачиваю файлы модпака (0/${files.length})…`, 0);
    let ok = 0;
    await pool(files, 6, async (f) => {
      const dest = safeJoin(dir, f.path);
      const urls = f.downloads || [];
      let lastErr;
      for (const u of urls) {
        try {
          await download(u, dest);
          if (f.hashes && f.hashes.sha1 && sha1(dest) !== f.hashes.sha1) throw new Error('hash mismatch');
          lastErr = null; break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr || !urls.length) throw new Error(`Не удалось скачать ${f.path}: ${lastErr ? lastErr.message : 'нет ссылок'}`);
      ok++;
      progress(`Скачиваю файлы модпака (${ok}/${files.length})…`, Math.round((ok / Math.max(1, files.length)) * 100));
    });
    progress('Распаковываю настройки…', 100);
    extractFolder(zip, ['overrides/', 'client-overrides/'], dir);
    return inst;
    } catch (e) { ctx.removeInstance(inst); throw e; }
  }

  // ---------- CurseForge format ----------
  async function installCurseZip(zip, fallbackName) {
    const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
    const mc = manifest.minecraft && manifest.minecraft.version;
    if (!mc) throw new Error('В модпаке не указана версия Minecraft');
    const ml = (manifest.minecraft.modLoaders || []).find((m) => m.primary) || (manifest.minecraft.modLoaders || [])[0];
    let loader = 'vanilla', loaderVersion = '';
    if (ml && ml.id) {
      const m = ml.id.match(/^(forge|fabric|quilt|neoforge)-(.+)$/i);
      if (m) { loader = m[1].toLowerCase(); loaderVersion = m[2]; }
    }
    const inst = ctx.createInstance({ name: manifest.name || fallbackName || 'Модпак', version: mc, loader, loaderVersion });
    const dir = path.join(instancesDir, inst.id);
    try {
    const required = (manifest.files || []).filter((f) => f.required !== false);
    const headers = ctx.cfHeaders();
    progress('Получаю список файлов CurseForge…', 0);
    const fileInfos = [];
    for (let i = 0; i < required.length; i += 200) {
      const chunk = required.slice(i, i + 200);
      const r = await ctx.postJSON(`${CF}/mods/files`, { fileIds: chunk.map((f) => f.fileID) }, headers);
      fileInfos.push(...r.data);
    }
    // which folder does each project belong to (mod / resource pack / shader)?
    const classOf = new Map();
    try {
      const ids = [...new Set(required.map((f) => f.projectID))];
      for (let i = 0; i < ids.length; i += 200) {
        const r = await ctx.postJSON(`${CF}/mods`, { modIds: ids.slice(i, i + 200) }, headers);
        r.data.forEach((m) => classOf.set(m.id, m.classId));
      }
    } catch { /* default to mods/ */ }

    let ok = 0;
    const missing = [];
    await pool(fileInfos, 6, async (f) => {
      const url = f.downloadUrl || `https://edge.forgecdn.net/files/${Math.floor(f.id / 1000)}/${f.id % 1000}/${encodeURIComponent(f.fileName)}`;
      const folder = CF_FOLDER[classOf.get(f.modId)] || 'mods';
      try { await download(url, safeJoin(path.join(dir, folder), f.fileName)); }
      catch { missing.push(f.fileName); }
      ok++;
      progress(`Скачиваю файлы модпака (${ok}/${fileInfos.length})…`, Math.round((ok / Math.max(1, fileInfos.length)) * 100));
    });
    progress('Распаковываю настройки…', 100);
    extractFolder(zip, [(manifest.overrides || 'overrides') + '/'], dir);
    inst.missing = missing;
    return inst;
    } catch (e) { ctx.removeInstance(inst); throw e; }
  }

  // ---------- public API ----------
  async function installFromFile(file) {
    let zip;
    try { zip = new AdmZip(file); } catch { throw new Error('Не удалось открыть файл — это не архив модпака'); }
    const base = path.basename(file).replace(/\.(mrpack|zip)$/i, '');
    if (zip.getEntry('modrinth.index.json')) return installMrpack(zip, base);
    if (zip.getEntry('manifest.json')) return installCurseZip(zip, base);
    throw new Error('Неизвестный формат: нужен .mrpack (Modrinth) или .zip с manifest.json (CurseForge)');
  }

  async function installModrinth(projectId) {
    progress('Ищу версию модпака…', 0);
    const versions = await getJSON(`${MR}/project/${projectId}/version`);
    if (!versions.length) throw new Error('У модпака нет доступных версий');
    const v = versions.find((x) => x.version_type === 'release') || versions[0];
    const f = v.files.find((x) => x.primary) || v.files[0];
    const tmp = path.join(tmpDir, `pack-${Date.now()}.mrpack`);
    progress('Скачиваю модпак…', 0);
    await download(f.url, tmp);
    try { return await installFromFile(tmp); } finally { fs.rmSync(tmp, { force: true }); }
  }

  async function installCurseForge(modId) {
    const headers = ctx.cfHeaders();
    progress('Ищу версию модпака…', 0);
    const d = await getJSON(`${CF}/mods/${modId}/files?pageSize=10`, { headers });
    const f = d.data.find((x) => x.releaseType === 1 && x.downloadUrl) || d.data.find((x) => x.downloadUrl) || d.data[0];
    if (!f) throw new Error('У модпака нет файлов');
    const url = f.downloadUrl || `https://edge.forgecdn.net/files/${Math.floor(f.id / 1000)}/${f.id % 1000}/${encodeURIComponent(f.fileName)}`;
    const tmp = path.join(tmpDir, `pack-${Date.now()}.zip`);
    progress('Скачиваю модпак…', 0);
    try { await download(url, tmp); }
    catch { throw new Error('Автор модпака запретил скачивание вне сайта CurseForge'); }
    try { return await installFromFile(tmp); } finally { fs.rmSync(tmp, { force: true }); }
  }

  async function searchModrinth({ query, offset }) {
    const facets = encodeURIComponent(JSON.stringify([['project_type:modpack']]));
    const d = await getJSON(`${MR}/search?query=${encodeURIComponent(query || '')}&limit=20&offset=${offset || 0}&facets=${facets}`);
    return d.hits.map((h) => ({
      source: 'modrinth', id: h.project_id, title: h.title, author: h.author, description: h.description,
      icon: h.icon_url, downloads: h.downloads, mc: (h.versions || []).slice(-1)[0] || ''
    }));
  }

  async function searchCurseForge({ query, offset }) {
    const p = new URLSearchParams({
      gameId: '432', classId: String(CF_PACK_CLASS), searchFilter: query || '',
      sortField: '2', sortOrder: 'desc', pageSize: '20', index: String(offset || 0)
    });
    const d = await getJSON(`${CF}/mods/search?${p}`, { headers: ctx.cfHeaders() });
    return d.data.map((m) => ({
      source: 'curseforge', id: String(m.id), title: m.name, author: (m.authors && m.authors[0] && m.authors[0].name) || '',
      description: m.summary, icon: m.logo && m.logo.thumbnailUrl, downloads: m.downloadCount
    }));
  }

  // Export an instance as .mrpack (settings + mods are stored inside "overrides").
  function exportMrpack(inst, destFile, opts = {}) {
    const dir = path.join(instancesDir, inst.id);
    const zip = new AdmZip();
    const deps = { minecraft: inst.version };
    const lv = inst.loaderVersion || loaderVersionFromId(inst.loader, inst.versionId);
    if (inst.loader === 'fabric') deps['fabric-loader'] = lv || '0.16.9';
    else if (inst.loader === 'quilt') deps['quilt-loader'] = lv || '0.27.1';
    else if (inst.loader === 'forge' && lv) deps.forge = lv;
    else if (inst.loader === 'neoforge' && lv) deps.neoforge = lv;

    const index = {
      formatVersion: 1, game: 'minecraft', versionId: opts.version || '1.0.0', name: inst.name,
      summary: 'Exported from Redshift Launcher', files: [], dependencies: deps
    };
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));

    const folders = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'defaultconfigs', 'kubejs', 'scripts'];
    if (opts.saves) folders.push('saves');
    let count = 0;
    for (const f of folders) {
      const p = path.join(dir, f);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { zip.addLocalFolder(p, 'overrides/' + f); count++; }
    }
    for (const f of ['options.txt', 'optionsshaders.txt', 'servers.dat']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) { zip.addLocalFile(p, 'overrides'); count++; }
    }
    zip.writeZip(destFile);
    return { folders: count, size: fs.statSync(destFile).size };
  }

  return { installFromFile, installModrinth, installCurseForge, searchModrinth, searchCurseForge, exportMrpack };
}

module.exports = { create, safeJoin };
