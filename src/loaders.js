// Mod loader installers: fabric, quilt, forge, neoforge.
// Every installer returns the id of a version folder inside <root>/versions
// that minecraft-launcher-core can start as a "custom" version.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];

function versionDirs(root) {
  const d = path.join(root, 'versions');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

// ----- Fabric / Quilt (profile json from their meta servers) -----
async function installProfileLoader({ meta, mc, root, getJSON, pin }) {
  const loaders = await getJSON(`${meta}/versions/loader/${mc}`);
  if (!loaders.length) throw new Error(`Загрузчик не поддерживает версию ${mc}`);
  const pick = (pin && loaders.find((l) => l.loader && l.loader.version === pin)) ||
    loaders.find((l) => l.loader && l.loader.stable !== false && !/beta|pre|rc/i.test(l.loader.version)) || loaders[0];
  const lv = pick.loader.version;
  const profile = await getJSON(`${meta}/versions/loader/${mc}/${lv}/profile/json`);
  const dir = path.join(root, 'versions', profile.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${profile.id}.json`), JSON.stringify(profile));
  return profile.id;
}

// ----- Forge / NeoForge (run official installer headless) -----
function runInstaller({ javaExe, jar, root, send }) {
  return new Promise((resolve, reject) => {
    const p = spawn(javaExe, ['-jar', jar, '--installClient', root], { cwd: root, windowsHide: true });
    const out = (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => send('log', '[installer] ' + l));
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Установщик завершился с кодом ${code}`))));
  });
}

function ensureLauncherProfiles(root) {
  const f = path.join(root, 'launcher_profiles.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ profiles: {}, version: 3 }));
}

async function forgeInstallerUrl(mc, getJSON, pin) {
  if (pin) {
    return { v: pin, url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${pin}/forge-${mc}-${pin}-installer.jar` };
  }
  const promos = (await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
  const v = promos[`${mc}-recommended`] || promos[`${mc}-latest`];
  if (!v) throw new Error(`Для Minecraft ${mc} нет сборки Forge`);
  return {
    v,
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${v}/forge-${mc}-${v}-installer.jar`
  };
}

async function neoForgeInstallerUrl(mc, getJSON, pin) {
  if (pin) return { v: pin, url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${pin}/neoforge-${pin}-installer.jar` };
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`NeoForge не поддерживает версию ${mc}`);
  const minor = +m[1], patch = +(m[2] || 0);
  if (minor === 20 && patch === 1) {
    // legacy artifact for 1.20.1
    const d = await getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge');
    const list = d.versions.filter((x) => x.startsWith('1.20.1-'));
    if (!list.length) throw new Error('Нет NeoForge для 1.20.1');
    const v = list[list.length - 1];
    return { v, url: `https://maven.neoforged.net/releases/net/neoforged/forge/${v}/forge-${v}-installer.jar` };
  }
  if (minor < 20 || (minor === 20 && patch < 2)) throw new Error('NeoForge есть только для версий 1.20.1 и новее');
  const prefix = `${minor}.${patch}.`;
  const d = await getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
  const list = d.versions.filter((x) => x.startsWith(prefix));
  if (!list.length) throw new Error(`Нет NeoForge для Minecraft ${mc}`);
  const stable = list.filter((x) => !/beta|alpha/i.test(x));
  const v = (stable.length ? stable : list).slice(-1)[0];
  return { v, url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar` };
}

async function installInstallerLoader({ kind, mc, root, javaExe, send, getJSON, download, tmpDir, pin }) {
  const info = kind === 'forge' ? await forgeInstallerUrl(mc, getJSON, pin) : await neoForgeInstallerUrl(mc, getJSON, pin);
  const already = versionDirs(root).find((n) => n.toLowerCase().includes(kind) && n.includes(info.v));
  if (already) return already;

  ensureLauncherProfiles(root);
  const jar = path.join(tmpDir, `${kind}-${mc}-${info.v}-installer.jar`);
  send('progress', { text: `Скачиваю установщик ${kind === 'forge' ? 'Forge' : 'NeoForge'} ${info.v}…`, percent: 5 });
  await download(info.url, jar);

  const before = new Set(versionDirs(root));
  send('progress', { text: `Устанавливаю ${kind === 'forge' ? 'Forge' : 'NeoForge'} (может занять пару минут)…`, percent: 20 });
  await runInstaller({ javaExe, jar, root, send });
  fs.rmSync(jar, { force: true });

  const created = versionDirs(root).filter((n) => !before.has(n));
  const id = created.find((n) => n.toLowerCase().includes(kind) && n.includes(info.v)) ||
    created.find((n) => n.toLowerCase().includes(kind)) ||
    versionDirs(root).find((n) => n.toLowerCase().includes(kind) && n.includes(info.v));
  if (!id) throw new Error('Установщик отработал, но версия не найдена');
  return id;
}

async function installLoader(ctx) {
  const { kind, mc, root, getJSON, pin } = ctx;
  if (kind === 'vanilla') return null;
  if (kind === 'fabric') return installProfileLoader({ meta: 'https://meta.fabricmc.net/v2', mc, root, getJSON, pin });
  if (kind === 'quilt') return installProfileLoader({ meta: 'https://meta.quiltmc.org/v3', mc, root, getJSON, pin });
  if (kind === 'forge' || kind === 'neoforge') return installInstallerLoader(ctx);
  throw new Error('Неизвестный загрузчик: ' + kind);
}

// Loaders whose mods an instance can run (Quilt runs Fabric mods too).
const modLoaders = (loader) => (loader === 'quilt' ? ['quilt', 'fabric'] : [loader]);

// Pull the loader's own version out of a version-folder id (best effort, used for modpack export).
function loaderVersionFromId(kind, id) {
  if (!id) return '';
  let m;
  if (kind === 'fabric' && (m = id.match(/^fabric-loader-(.+)-\d[\w.]*$/))) return m[1];
  if (kind === 'quilt' && (m = id.match(/^quilt-loader-(.+)-\d[\w.]*$/))) return m[1];
  if (kind === 'forge' && (m = id.match(/forge-(\d[\w.]*)$/))) return m[1];
  if (kind === 'neoforge' && (m = id.match(/neoforge-(\d[\w.\-]*)$/))) return m[1];
  return '';
}

module.exports = { LOADERS, installLoader, modLoaders, loaderVersionFromId };
