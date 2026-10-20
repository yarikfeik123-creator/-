const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const extract = require('extract-zip');
const { execFile } = require('child_process');
const run = require('util').promisify(execFile);

const cfgFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({
  ram: 4,
  javaPath: '',
  gameDir: path.join(app.getPath('home'), '.blocklaunch'),
  closeOnLaunch: true,
  account: null, // { type: 'microsoft' | 'offline', name }
  builds: [{ id: 'vanilla', name: 'Ванильная', version: '1.21.4' }],
  selected: 'vanilla',
});
const load = () => {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { return defaults(); }
};
const save = (s) => fs.writeFileSync(cfgFile(), JSON.stringify(s, null, 2));

let win;
let mclcAuth = null; // токен Microsoft живёт только в памяти

const send = (ch, msg) => win && !win.isDestroyed() && win.webContents.send(ch, msg);

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 640, minWidth: 820, minHeight: 540,
    backgroundColor: '#0e1014', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('Ошибка загрузки:', code, desc));
  win.webContents.on('render-process-gone', (_e, d) => console.log('Рендер упал:', d.reason));
  win.webContents.on('console-message', (...a) => console.log('[окно]', a[2] ?? a[1]?.message));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.loadFile('index.html');
}


const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';

// Какая Java нужна версии игры (берём из данных Mojang, запасной вариант — по номеру версии)
async function javaMajor(version) {
  try {
    const man = await (await fetch(MANIFEST, { signal: AbortSignal.timeout(8000) })).json();
    const v = man.versions.find((x) => x.id === version);
    const info = await (await fetch(v.url, { signal: AbortSignal.timeout(8000) })).json();
    return info.javaVersion?.majorVersion || 8;
  } catch {
    const [a, b, c] = version.split('.').map(Number);
    if (a !== 1) return 21;
    if (b <= 16) return 8;
    if (b < 20 || (b === 20 && (c || 0) < 5)) return 17;
    return 21;
  }
}

// Находит скачанную Java или скачивает её с Adoptium (Windows, macOS, Linux)
async function ensureJava(major) {
  const isWin = process.platform === 'win32';
  const dir = path.join(app.getPath('userData'), 'java', String(major));
  const rel = process.platform === 'darwin' ? ['Contents', 'Home', 'bin', javaBin] : ['bin', javaBin];
  const find = () => {
    if (!fs.existsSync(dir)) return null;
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, ...rel);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  let bin = find();
  if (bin) return bin;

  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  fs.mkdirSync(dir, { recursive: true });
  send('log', `Скачиваю Java ${major}…`);
  const res = await fetch(`https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`);
  if (!res.ok) throw new Error(`Не удалось скачать Java ${major} (код ${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  const file = path.join(dir, isWin ? 'java.zip' : 'java.tar.gz');
  const out = fs.createWriteStream(file);
  let got = 0, last = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    if (total && Date.now() - last > 500) { last = Date.now(); send('log', `Скачиваю Java ${major}: ${Math.round((got / total) * 100)}%`); }
  }
  await new Promise((r) => out.end(r));
  send('log', 'Распаковываю Java…');
  if (isWin) await extract(file, { dir });
  else await run('tar', ['-xzf', file, '-C', dir]);
  fs.unlinkSync(file);
  bin = find();
  if (!bin) throw new Error('Java скачана, но не найдена после распаковки');
  return bin;
}

ipcMain.handle('settings:get', () => load());
ipcMain.handle('settings:set', (_e, s) => { save(s); });

ipcMain.handle('versions', async () => {
  const r = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return j.versions.filter((v) => v.type === 'release').map((v) => v.id).slice(0, 40);
});

ipcMain.handle('login:microsoft', async () => {
  const xbox = await new Auth('select_account').launch('electron');
  const mc = await xbox.getMinecraft();
  mclcAuth = mc.mclc();
  const s = load();
  s.account = { type: 'microsoft', name: mc.profile.name };
  save(s);
  return s.account;
});

ipcMain.handle('login:offline', (_e, name) => {
  const nick = String(name || '').trim();
  if (!/^\w{3,16}$/.test(nick)) throw new Error('Ник: 3–16 символов, буквы, цифры и _');
  mclcAuth = Authenticator.getAuth(nick);
  const s = load();
  s.account = { type: 'offline', name: nick };
  save(s);
  return s.account;
});

ipcMain.handle('logout', () => {
  mclcAuth = null;
  const s = load();
  s.account = null;
  save(s);
});

ipcMain.handle('pick:dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('play', async () => {
  const s = load();
  const build = s.builds.find((b) => b.id === s.selected);
  if (!build) return { error: 'Выбери сборку' };
  if (!mclcAuth && s.account?.type === 'offline') mclcAuth = Authenticator.getAuth(s.account.name);
  if (!mclcAuth) return { error: 'Сессия Microsoft истекла. Войди заново.' };

  let javaPath = s.javaPath;
  if (!javaPath) {
    try { javaPath = await ensureJava(await javaMajor(build.version)); }
    catch (e) { return { error: e.message }; }
  }

  const launcher = new Client();
  let hidden = false;
  launcher.on('progress', (p) => send('log', `Загрузка (${p.type}): ${p.task} из ${p.total}`));
  launcher.on('debug', (m) => send('log', m));
  launcher.on('data', (m) => {
    send('log', String(m));
    if (s.closeOnLaunch && !hidden) { hidden = true; win.hide(); }
  });
  launcher.on('close', (code) => {
    send('log', `Игра закрыта (код ${code})`);
    send('state', 'idle');
    win.show();
  });

  try {
    const custom = build.loader === 'fabric' ? await ensureFabric(build.version, s.gameDir) : null;
    const proc = await launcher.launch({
      authorization: mclcAuth,
      root: s.gameDir,
      overrides: { gameDirectory: path.join(s.gameDir, 'instances', build.id) },
      version: { number: build.version, type: 'release', ...(custom && { custom }) },
      memory: { max: `${s.ram}G`, min: '1G' },
      javaPath,
    });
    if (!proc) return { error: 'Не удалось запустить. Проверь Java и версию.' };
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ---------- Fabric ----------
async function ensureFabric(mc, root) {
  const list = await (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mc}`, { signal: AbortSignal.timeout(10000) })).json();
  const lv = (list.find((e) => e.loader.stable) || list[0])?.loader.version;
  if (!lv) throw new Error(`Для Minecraft ${mc} нет Fabric`);
  const id = `fabric-loader-${lv}-${mc}`;
  const jsonPath = path.join(root, 'versions', id, `${id}.json`);
  if (!fs.existsSync(jsonPath)) {
    send('log', `Устанавливаю Fabric ${lv}…`);
    const prof = await (await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${lv}/profile/json`)).text();
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, prof);
  }
  return id;
}

// ---------- Modrinth ----------
const UA = { 'User-Agent': 'BlockLaunch/1.0' };
const mr = async (p) => {
  const r = await fetch('https://api.modrinth.com/v2' + p, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Modrinth вернул ошибку ${r.status}`);
  return r.json();
};
const cur = () => {
  const s = load();
  const b = s.builds.find((x) => x.id === s.selected) || s.builds[0];
  return { s, b, dir: path.join(s.gameDir, 'instances', b.id) };
};

async function installMod(id, mc, modsDir, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  const q = `loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;
  const vers = await mr(`/project/${id}/version?${q}`);
  if (!vers.length) throw new Error(`Нет версии мода для Minecraft ${mc} (Fabric)`);
  const v = vers[0];
  const f = v.files.find((x) => x.primary) || v.files[0];
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, path.basename(f.filename));
  if (!fs.existsSync(dest)) {
    const r = await fetch(f.url, { headers: UA });
    if (!r.ok) throw new Error(`Не удалось скачать ${f.filename}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  const names = [f.filename];
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id) {
      try { names.push(...(await installMod(d.project_id, mc, modsDir, seen))); } catch {}
    }
  }
  return names;
}

ipcMain.handle('mods:search', async (_e, q) => {
  const { b } = cur();
  const facets = JSON.stringify([['project_type:mod'], ['categories:fabric'], [`versions:${b.version}`]]);
  const r = await mr(`/search?query=${encodeURIComponent(q)}&limit=20&facets=${encodeURIComponent(facets)}`);
  return r.hits.map((h) => ({ id: h.project_id, title: h.title, text: h.description }));
});
ipcMain.handle('mods:install', (_e, id) => { const { b, dir } = cur(); return installMod(id, b.version, path.join(dir, 'mods')); });
ipcMain.handle('mods:list', () => {
  const d = path.join(cur().dir, 'mods');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => /\.jar(\.disabled)?$/.test(f)).map((f) => ({ file: f, on: f.endsWith('.jar') }));
});
ipcMain.handle('mods:toggle', (_e, f) => {
  const from = path.join(cur().dir, 'mods', path.basename(f));
  fs.renameSync(from, f.endsWith('.disabled') ? from.slice(0, -9) : from + '.disabled');
});
ipcMain.handle('mods:remove', (_e, f) => fs.unlinkSync(path.join(cur().dir, 'mods', path.basename(f))));

// ---------- Скины (офлайн-режим) ----------
const skinFile = (s) => path.join(app.getPath('userData'), 'skins', `${s.account?.name || 'player'}.png`);
ipcMain.handle('skin:load', () => {
  const p = skinFile(load());
  return fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : null;
});
ipcMain.handle('skin:apply', async (_e, dataUrl) => {
  const { s, b, dir } = cur();
  if (s.account?.type !== 'offline') throw new Error('У лицензионного аккаунта скин меняется на сайте minecraft.net');
  if (!String(dataUrl).startsWith('data:image/png;base64,')) throw new Error('Нужен PNG');
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.mkdirSync(path.dirname(skinFile(s)), { recursive: true });
  fs.writeFileSync(skinFile(s), buf);
  if (b.loader !== 'fabric') return 'Скин сохранён. Чтобы увидеть его в игре, переключи сборку на Fabric (вкладка «Моды») и нажми «Применить» ещё раз.';
  const sk = path.join(dir, 'CustomSkinLoader', 'LocalSkin', 'skins');
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, `${s.account.name}.png`), buf);
  await installMod('customskinloader', b.version, path.join(dir, 'mods'));
  return 'Скин применён. Запусти игру — мод CustomSkinLoader уже установлен.';
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
