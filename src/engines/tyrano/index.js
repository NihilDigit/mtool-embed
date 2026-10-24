'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('../../asar');
const { compileDictionary } = require('./runtime-inject');
const RUNTIME_NAME = 'mtool-embed-runtime.js';
const MARKER = '<!-- mtool-embed:start -->';
const END_MARKER = '<!-- mtool-embed:end -->';
const FONT = '"Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "SimHei", sans-serif';
const FONT_MARKER = '/* mtool-embed:font */';
const BACKUP = '.mtool-embed';
const MANAGED_FILES = ['index.html', 'tyrano/css/font.css', 'data/system/Config.tjs', RUNTIME_NAME, '翻译文件.json'];

function detect(game) {
  game = fs.realpathSync(path.resolve(game));
  if (!fs.statSync(game).isDirectory()) throw new Error('游戏路径必须是目录');
  const archives = [path.join(game, 'resources/app.asar'), path.join(game, 'app.asar')];
  for (const archive of archives) {
    if (!fs.existsSync(archive)) continue;
    const { header } = asar.readHeader(archive);
    if (asar.getEntry(header, 'index.html') && asar.getEntry(header, 'tyrano') && asar.getEntry(header, 'data/system/Config.tjs')) return { engine: 'tyrano', kind: 'asar', game, root: archive };
  }
  for (const root of [game, path.join(game, 'resources/app'), path.join(game, 'app')]) {
    if (fs.existsSync(path.join(root, 'index.html')) && fs.existsSync(path.join(root, 'tyrano')) && fs.existsSync(path.join(root, 'data/system/Config.tjs'))) return { engine: 'tyrano', kind: 'directory', game, root };
  }
  return null;
}
function read(target, name) {
  if (target.kind === 'asar') return asar.readFile(target.root, name);
  const file = path.join(target.root, name);
  const actual = fs.realpathSync(file);
  if (!actual.startsWith(fs.realpathSync(target.root) + path.sep)) throw new Error(`游戏文件链接越界: ${name}`);
  return fs.readFileSync(actual);
}
function exists(target, name) {
  if (target.kind === 'asar') return !!asar.getEntry(asar.readHeader(target.root).header, name);
  return fs.existsSync(path.join(target.root, name));
}
function injectHtml(text) {
  const block = `${MARKER}\n<script src="./${RUNTIME_NAME}"></script>\n${END_MARKER}`;
  const start = text.indexOf(MARKER), end = text.indexOf(END_MARKER);
  if (start >= 0) {
    if (end < start) throw new Error('index.html 注入标记不完整');
    return text.slice(0, start) + block + text.slice(end + END_MARKER.length);
  }
  // 在引擎脚本加载后、DOMContentLoaded 前同步安装 hook。
  if (/<\/body\s*>/i.test(text)) return text.replace(/<\/body\s*>/i, block + '\n</body>');
  return text + '\n' + block + '\n';
}
function injectCss(text) {
  const endMarker = '/* mtool-embed:font:end */';
  const block = FONT_MARKER + '\n/* 系统字体回退，不随游戏分发字体文件。 */\n' + '.message_inner, .message_inner *, .message0_fore, .message0_fore *, .glink_button, .button_menu, .text_area, .chara_name_area, .chara_name_area * { font-family: ' + FONT + ' !important; }\n' + endMarker;
  const start = text.indexOf(FONT_MARKER), end = text.indexOf(endMarker);
  if (start >= 0) {
    if (end < start) throw new Error('font.css 注入标记不完整');
    return text.slice(0, start) + block + text.slice(end + endMarker.length);
  }
  return text + '\n\n' + block + '\n';
}
function injectConfig(text) {
  let changed = false;
  text = text.replace(/(^[ \t]*;?[ \t]*(?:userFace|defaultFont)[ \t]*=[ \t]*)([^\r\n]*)/gm, (all, prefix, value) => {
    changed = true;
    const commentAt = value.indexOf('//');
    const comment = commentAt >= 0 ? value.slice(commentAt) : '';
    const existing = (commentAt >= 0 ? value.slice(0, commentAt) : value).trim().replace(/;$/, '').replace(/^["']|["']$/g, '');
    const faces = existing.split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    for (const face of ['Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'PingFang SC', 'SimHei', 'sans-serif']) if (!faces.includes(face)) faces.push(face);
    return prefix + faces.join(',') + (comment ? ' ' + comment : '');
  });
  return changed ? text : text + '\n;userFace=Microsoft YaHei,Noto Sans CJK SC,Noto Sans SC,PingFang SC,SimHei,sans-serif\n';
}
function manifestPath(game) { return path.join(game, BACKUP, 'manifest.json'); }
function readManifest(game) {
  const file = manifestPath(game);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(path.join(game, BACKUP)).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw new Error('拒绝符号链接备份目录或清单');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (m.version !== 1 || m.engine !== 'tyrano' || !['asar', 'directory'].includes(m.kind) || !Array.isArray(m.files)) throw new Error('不支持的备份清单');
  for (const name of [m.root, ...m.files.map(f => f.path)]) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).some(p => p === '..') || name.includes('\0')) throw new Error('备份清单包含不安全路径');
  }
  const normalize = name => name.replace(/\\/g, '/');
  const root = normalize(m.root);
  if (m.kind === 'asar' ? !['resources/app.asar', 'app.asar'].includes(root) : !['', 'resources/app', 'app'].includes(root)) throw new Error('备份根目录无效');
  const allowed = new Set(m.kind === 'asar' ? [root] : MANAGED_FILES.map(name => root ? root + '/' + name : name));
  if (m.files.length !== allowed.size) throw new Error('备份文件列表不完整');
  const seen = new Set();
  m.files.forEach((entry, index) => {
    const name = normalize(entry.path);
    if (!allowed.has(name) || seen.has(name) || entry.backup !== String(index) || typeof entry.existed !== 'boolean' || (entry.existed && !/^[a-f0-9]{64}$/.test(entry.sha256))) throw new Error('备份文件记录无效');
    seen.add(name);
  });
  return m;
}
function shaFile(file) {
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buf = Buffer.alloc(4 * 1024 * 1024);
  try { let size; while ((size = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, size)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function atomicWrite(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.mtool-' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, buffer, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function ensureBackup(target, names) {
  const existing = readManifest(target.game);
  const backupDir = path.join(target.game, BACKUP);
  for (const name of names) {
    const destination = target.kind === 'asar' ? target.root : path.join(target.root, name);
    let parent = path.dirname(destination);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const actual = fs.realpathSync(parent);
    if (actual !== target.game && !actual.startsWith(target.game + path.sep)) throw new Error('注入路径越界');
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('拒绝注入符号链接');
  }
  if (existing) {
    if (existing.kind !== target.kind || existing.root !== path.relative(target.game, target.root)) throw new Error('游戏布局已改变，请先检查备份');
    return existing;
  }
  if (fs.existsSync(backupDir)) throw new Error('备份目录存在但清单缺失，请人工检查后重试');
  fs.mkdirSync(backupDir);
  const files = [];
  const originals = target.kind === 'asar' ? [path.relative(target.game, target.root)] : names.map(name => path.relative(target.game, path.join(target.root, name)));
  for (const [index, name] of originals.entries()) {
    const file = path.join(target.game, name), present = fs.existsSync(file);
    if (present) {
      const actual = fs.realpathSync(file);
      if (!actual.startsWith(target.game + path.sep) || !fs.statSync(actual).isFile()) throw new Error('备份目标必须是游戏内普通文件');
      fs.copyFileSync(file, path.join(backupDir, String(index)));
    }
    files.push({ path: name, backup: String(index), existed: present, sha256: present ? shaFile(file) : null });
  }
  const manifest = { version: 1, engine: 'tyrano', kind: target.kind, root: path.relative(target.game, target.root), files };
  atomicWrite(manifestPath(target.game), JSON.stringify(manifest, null, 2));
  return manifest;
}
function inspect(game) {
  const target = detect(game);
  if (!target) return { engine: null, supported: false, game: path.resolve(game) };
  const index = read(target, 'index.html').toString('utf8');
  return { ...target, supported: true, injected: index.includes(MARKER), backup: !!readManifest(target.game), externalDictionary: fs.existsSync(path.join(target.game, '翻译文件.json')), embeddedDictionary: exists(target, '翻译文件.json') };
}
async function inject(game, options = {}) {
  const target = detect(game);
  if (!target) throw new Error('未找到支持的 TyranoScript 游戏布局');
  let dictionary = options.dictionary && path.resolve(options.dictionary);
  if (!dictionary && fs.existsSync(path.join(target.game, '翻译文件.json'))) dictionary = path.join(target.game, '翻译文件.json');
  const raw = dictionary ? fs.readFileSync(dictionary) : exists(target, '翻译文件.json') ? read(target, '翻译文件.json') : null;
  if (!raw) throw new Error('找不到翻译文件.json，请使用 --dictionary 指定');
  const compiled = compileDictionary(raw.toString('utf8'));
  if (!compiled.exactMap.size) throw new Error('翻译词典为空');
  const replacements = {
    'index.html': injectHtml(read(target, 'index.html').toString('utf8')),
    'tyrano/css/font.css': injectCss(exists(target, 'tyrano/css/font.css') ? read(target, 'tyrano/css/font.css').toString('utf8') : ''),
    'data/system/Config.tjs': injectConfig(read(target, 'data/system/Config.tjs').toString('utf8')),
    [RUNTIME_NAME]: fs.readFileSync(path.join(__dirname, 'runtime-inject.js')),
    '翻译文件.json': raw
  };
  // 内容相同不重复尾追加，避免重复注入增大 ASAR。
  const changed = Object.fromEntries(Object.entries(replacements).filter(([name, value]) => !exists(target, name) || !read(target, name).equals(Buffer.from(value))));
  if (!Object.keys(changed).length) return { ...inspect(game), changed: [], entries: compiled.exactMap.size };
  ensureBackup(target, Object.keys(replacements));
  if (target.kind === 'asar') await asar.appendFiles(target.root, changed);
  else for (const [name, value] of Object.entries(changed)) atomicWrite(path.join(target.root, name), value);
  return { ...inspect(game), changed: Object.keys(changed), entries: compiled.exactMap.size };
}
function restore(game) {
  game = fs.realpathSync(path.resolve(game));
  const manifest = readManifest(game);
  if (!manifest) throw new Error('未找到 mtool-embed 备份');
  // 先验证所有备份，再恢复，避免损坏的备份导致部分覆盖。
  for (const entry of manifest.files) {
    if (!/^\d+$/.test(entry.backup)) throw new Error('备份文件名无效');
    if (entry.existed) {
      const backupFile = path.join(game, BACKUP, entry.backup);
      if (!fs.lstatSync(backupFile).isFile() || shaFile(backupFile) !== entry.sha256) throw new Error(`备份校验失败: ${entry.path}`);
    }
    const destination = path.join(game, entry.path);
    let parent = path.dirname(destination);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (fs.realpathSync(parent) !== game && !fs.realpathSync(parent).startsWith(game + path.sep)) throw new Error('还原路径越界');
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('拒绝还原符号链接');
  }
  for (const entry of manifest.files) {
    const destination = path.join(game, entry.path);
    if (entry.existed) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temp = destination + '.mtool-' + crypto.randomUUID() + '.tmp';
      try { fs.copyFileSync(path.join(game, BACKUP, entry.backup), temp); fs.renameSync(temp, destination); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    } else if (fs.existsSync(destination)) fs.unlinkSync(destination);
  }
  // 保留已校验备份，允许重复还原；后续注入仍以首次备份为基准。
  return { restored: true, game, files: manifest.files.map(entry => entry.path), backupRetained: true };
}
module.exports = { id: 'tyrano', detect, inspect, inject, restore, injectHtml, injectCss, injectConfig };
