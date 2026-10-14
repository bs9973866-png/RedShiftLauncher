// Performance helpers: JVM presets, video option tweaks, FPS mod lists.
const fs = require('fs');
const path = require('path');

// Aikar-style G1 flags: well-known, safe on Java 8..21.
const G1_BASE = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'
];

const PRESETS = {
  none: { title: 'Без оптимизаций', flags: [], fixedHeap: false },
  balanced: { title: 'Баланс', flags: G1_BASE, fixedHeap: false },
  max: {
    title: 'Максимум FPS',
    flags: [...G1_BASE, '-XX:+AlwaysPreTouch', '-XX:+UseStringDeduplication'],
    fixedHeap: true
  },
  lowend: {
    title: 'Слабый ПК',
    flags: ['-XX:+UseSerialGC', '-XX:+DisableExplicitGC', '-XX:TieredStopAtLevel=1', '-Xss1M'],
    fixedHeap: false
  }
};

function jvmArgs(settings) {
  const preset = PRESETS[settings.jvmPreset] || PRESETS.balanced;
  const extra = (settings.jvmArgs || '').split(/\s+/).filter(Boolean);
  return { args: [...preset.flags, ...extra], fixedHeap: preset.fixedHeap };
}

// Video options merged into options.txt (unknown keys are ignored by the game).
function videoTweaks(level) {
  const base = {
    renderDistance: 8, simulationDistance: 8, entityDistanceScaling: '0.75',
    particles: 2, entityShadows: 'false', biomeBlendRadius: 1, mipmapLevels: 2,
    enableVsync: 'false', maxFps: 260, graphicsMode: 0, fancyGraphics: 'false',
    renderClouds: 'false', ao: 'false', bobView: 'false', attackIndicator: 0
  };
  if (level === 'extreme') Object.assign(base, { renderDistance: 6, simulationDistance: 5, biomeBlendRadius: 0, mipmapLevels: 0, particles: 2 });
  return base;
}

function applyVideoTweaks(gameDir, level = 'balanced') {
  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, 'options.txt');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const map = new Map(lines.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1)]; }));
  const fresh = map.size === 0;
  for (const [k, v] of Object.entries(videoTweaks(level))) {
    // existing file: only touch keys the game already wrote (plus universal ones); fresh file: write everything
    if (fresh || map.has(k) || ['renderDistance', 'maxFps', 'enableVsync', 'particles'].includes(k)) map.set(k, String(v));
  }
  fs.writeFileSync(file, [...map].map(([k, v]) => `${k}:${v}`).join('\n') + '\n');
}

// Modrinth project slugs per loader.
const FPS_MODS = {
  fabric: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix', 'krypton', 'dynamic-fps'],
  quilt: ['qsl', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix', 'krypton'],
  forge: ['embeddium', 'modernfix', 'ferrite-core', 'entityculling'],
  neoforge: ['embeddium', 'modernfix', 'ferrite-core', 'entityculling']
};

module.exports = { PRESETS, jvmArgs, applyVideoTweaks, FPS_MODS };
