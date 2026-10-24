const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const asar = require('../src/asar');
const tyrano = require('../src/engines/tyrano');
const { compileDictionary, loadDictionary, install } = require('../src/engines/tyrano/runtime-inject');
const { main } = require('../src/cli');
const temporary = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtool-embed-test-')); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const text = val => ({ name: 'text', pm: { val }, line: 1 });
const emb = exp => ({ name: 'emb', pm: { exp } });
function baseFiles() { return { 'index.html': '<html><head></head><body></body></html>', 'tyrano/css/font.css': '.message_inner { color: white; }', 'data/system/Config.tjs': ';userFace=Original Font\n;projectID=test\n', 'asset.bin': Buffer.from([1, 2, 3, 4]) }; }
function makeArchive(file, files) {
  const header = { files: {} }, chunks = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const buffer = Buffer.from(value); const parts = name.split('/'); let cursor = header;
    for (const part of parts.slice(0, -1)) { cursor.files[part] ||= { files: {} }; cursor = cursor.files[part]; }
    cursor.files[parts.at(-1)] = { size: buffer.length, offset: String(offset), integrity: asar.integrity(buffer) };
    offset += buffer.length; chunks.push(buffer);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.concat([asar.encodeHeader(header), ...chunks]));
}
function game(kind = 'directory') {
  const dir = temp(), files = baseFiles();
  if (kind === 'asar') makeArchive(path.join(dir, 'resources/app.asar'), files);
  else for (const [name, value] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), value); }
  fs.writeFileSync(path.join(dir, '翻译文件.json'), JSON.stringify({ '星の海': '星之海' }));
  return dir;
}

describe('词典与动态文本', () => {
  test('原文精确优先，保留空白，非字符串忽略与 BOM', () => {
    const d = compileDictionary('\uFEFF' + JSON.stringify({ '空': '天空', ' 空 ': ' 天空 ', '数字': 42 }));
    expect(d.translateText('空')).toBe('天空'); expect(d.translateText('\t空\n')).toBe('\t天空\n');
    expect(d.translateText('数字')).toBe('数字'); expect(() => compileDictionary([])).toThrow();
  });
  test('从任意破损表达式位置恢复转义字面量，显式字典优先', () => {
    const d = compileDictionary({ "&'体力(残り' + f.any": "&'体力(剩余' + f.any", "+ 'ポイント)'": "+ '积分)'", '&"青い\\n石"+f.x': '&"蓝色\\n石"+f.x', 'の倍数！続き': '的倍数！后续' });
    expect(d.translateText('体力(残り')).toBe('体力(剩余'); expect(d.translateText('ポイント)')).toBe('积分)');
    expect(d.translateText('青い\n石')).toBe('蓝色\n石'); expect(d.translateText('の倍数')).toBe('的倍数');
    expect(d.translateText('17の倍数')).toBe('17的倍数');
  });
  test('任意前后缀括号、冒号递归、数字量词与音符段', () => {
    const d = compileDictionary({ '称号は【': '称号是【', '】ですか': '】吗', '星': '星辰', '観測': '观测', '待機': '等待', '点': '分' });
    expect(d.translateText('称号は【星】ですか')).toBe('称号是【星辰】吗');
    expect(d.translateText('観測：待機')).toBe('观测：等待'); expect(d.translateText('観測:10個')).toBe('观测:10个');
    expect(d.translateText('観測:12点')).toBe('观测:12分'); expect(d.translateText('星♪ マイナス星♪')).toBe('星辰♪ 负星辰♪');
    expect(d.translateText('観測：星:待機')).toBe('观测：星辰:等待');
  });
});
describe('安全代码与存档', () => {
  const make = () => compileDictionary({ '青い石': '蓝色宝石', '笑顔': '微笑', 'internal_id': '不能改', 'image.png': '不能改', 'folder/青い石': '不能改', 'の倍数': '的倍数' });
  test('代码字面量不执行输入，保留路径、ID、注释和正则', () => {
    const d = make(), code = "f.x='青い石'; f.y=\"image.png\"; f.z='internal_id'; // '青い石'\nconst r=/'青い石'/; const t=`青い石`;";
    const converted = d.translateJsCodeLiterals(code);
    expect(converted).toContain('f.x="蓝色宝石"'); expect(converted).toContain('f.y="image.png"'); expect(converted).toContain("f.z='internal_id'");
    expect(converted).toContain("// '青い石'"); expect(converted).toContain("/'青い石'/"); expect(converted).toContain('const t="蓝色宝石"');
    expect(d.translateJsCodeLiterals("f.x='\\u9752い石'")).toBe('f.x="蓝色宝石"');
    expect(d.translateJsCodeLiterals('tf.count[0]+\'の倍数\'')).toBe('tf.count[0]+"的倍数"');
    expect(d.translateJsCodeLiterals("if (f.ok) /'青い石'/.test(x); f.n=9 / 3; f.x='青い石';")).toBe("if (f.ok) /'青い石'/.test(x); f.n=9 / 3; f.x=\"蓝色宝石\";");
  });
  test('递归纯对象与数组，跳过表情 ID、内部 ID、路径、getter、冻结对象和循环', () => {
    const d = make(); d.faceIds.add('笑顔');
    const obj = { any: ['青い石', { anyOther: '青い石' }], face: '笑顔', id: 'internal_id', path: 'folder/青い石', file: 'image.png', date: new Date(), frozen: Object.freeze({ value: '青い石' }) };
    Object.defineProperty(obj, 'getter', { enumerable: true, get() { throw Error('不能触发'); } }); obj.self = obj;
    d.translateStateObject(obj); expect(obj.any).toEqual(['蓝色宝石', { anyOther: '蓝色宝石' }]); expect(obj.face).toBe('笑顔'); expect(obj.id).toBe('internal_id'); expect(obj.file).toBe('image.png'); expect(obj.frozen.value).toBe('青い石');
  });
});
describe('AST 重写', () => {
  test('三节点通用量词后置重排与标点', () => {
    const d = compileDictionary({ '星の欠片を': '星之碎片', '個獲得しました！': '获得了' });
    const expr = emb('f.counter[0]'), arr = [text('星の欠片を'), expr, text('個獲得しました！')];
    d.transformScenarioArray(arr); expect(arr.map(x => x.pm.val || x.pm.exp)).toEqual(['获得了', 'f.counter[0]', '个星之碎片！']); expect(arr[1]).toBe(expr);
  });
  test('五节点来源、宾语与数量语序', () => {
    const d = compileDictionary({ '旅人は': '旅人', 'から宝石を': '给的宝石', '宝石': '宝石头', '枚もらった！': '获得了' });
    const arr = [text('旅人は'), emb('f.source'), text('から宝石を'), emb('f.count'), text('枚もらった！')];
    d.transformScenarioArray(arr); expect(arr.map(x => x.pm.val || x.pm.exp)).toEqual(['旅人从', 'f.source', '获得了', 'f.count', '枚宝石头！']);
  });
  test('五节点从已翻译片段推导宾语，不依赖独立名词条目', () => {
    const d = compileDictionary({ '冒険者は': '冒险者', 'から琥珀を': '给的琥珀', '個もらった！': '收到了' });
    const arr = [text('冒険者は'), emb('f.person'), text('から琥珀を'), emb('f.quantity'), text('個もらった！')];
    d.transformScenarioArray(arr); expect(arr.map(n => n.pm.val || n.pm.exp)).toEqual(['冒险者从', 'f.person', '收到了', 'f.quantity', '个琥珀！']);
  });
  test('不满足结构或动词条件不重排', () => {
    const d = compileDictionary({ '星を': '获得星', '個獲得しました！': '未知内容' });
    const arr = [text('星を'), emb('x'), text('個獲得しました！')]; d.transformScenarioArray(arr);
    expect(arr[0].pm.val).toBe('获得星');
  });
  test.each(['[主人公名字]', '[主人公]', '[主角]', '[我]', '（主人公）', '（我）', '〇〇', '*', '范', ' '])('前后文本占位符 %s 嵌入并重算标签', placeholder => {
    const d = compileDictionary({ '原文': '欢迎' + placeholder + '归来' });
    const x = emb('f.name'), arr = [text('原文'), x, { name: 'label', pm: { label_name: 'next', index: 2 } }];
    const res = { array_s: arr, map_label: { next: { index: 2, line: 7 } } };
    d.transformScenarioArray(res); expect(arr.slice(0, 3).map(n => n.pm.val || n.pm.exp)).toEqual(['欢迎', 'f.name', '归来']); expect(arr[3].pm.index).toBe(3); expect(res.map_label.next).toEqual({ index: 3, line: 7 });
    d.transformScenarioArray(res); expect(arr.length).toBe(4);
    const second = [x, text('原文')]; d.transformScenarioArray(second); expect(second.map(n => n.pm.val || n.pm.exp)).toEqual(['欢迎', 'f.name', '归来']);
  });
  test('格助词与中文介词嵌入，显示字段翻译而内部属性不动', () => {
    const d = compileDictionary({ 'のを助ける': '想要让的朋友获救', '題名': '标题' });
    const arr = [emb('f.friend'), text('のを助ける'), { name: 'glink', pm: { text: '題名', name: '題名', storage: '題名' } }];
    d.transformScenarioArray(arr); expect(arr.slice(0, 3).map(n => n.pm.val || n.pm.exp)).toEqual(['想要让', 'f.friend', '的朋友获救']); expect(arr[3].pm).toEqual({ text: '标题', name: '題名', storage: '題名' });
  });
  test('大剧本不使用 apply 参数展开', () => {
    const arr = Array.from({ length: 150000 }, () => text('未翻译')); compileDictionary({}).transformScenarioArray(arr); expect(arr.length).toBe(150000);
  });
});
describe('双源词典与真实调用签名 hook', () => {
  test('外置词典优先可执行文件同级，其次 cwd，最后同步 XHR', () => {
    const calls = [], host = { process: { execPath: '/games/app/game.exe', cwd: () => '/work' }, studio_api: { fs_default: { readFileSync(file) { calls.push(file); if (file === '/work/翻译文件.json') return '{"空":"天空"}'; throw Error('missing'); } } }, XMLHttpRequest: class { open(method, url, async) { expect(async).toBe(false); } send() { this.status = 200; this.responseText = '{"空":"宇宙"}'; } } };
    expect(loadDictionary(host).translateText('空')).toBe('天空'); expect(calls).toEqual(['/games/app/翻译文件.json', '/work/翻译文件.json']);
    host.studio_api.fs_default.readFileSync = () => { throw Error('denied'); }; expect(loadDictionary(host).translateText('空')).toBe('宇宙');
  });
  test('Node require 来源与无效 XHR 报错', () => {
    const host = { require(name) { if (name === 'fs') return { readFileSync() { return '{"空":"宇宙"}'; } }; if (name === 'path') return path; if (name === 'process') return { execPath: 'C:/app/game.exe' }; } };
    expect(loadDictionary(host).translateText('空')).toBe('宇宙');
    expect(() => loadDictionary({ XMLHttpRequest: class { open() {} send() { this.status = 404; } } })).toThrow('无法加载');
  });
  test('parser、loadScenario、evalScript、convertEntity、loadGameData 保留 this、回调和返回值', () => {
    const d = compileDictionary({ '青い石': '蓝色宝石', '笑顔': '微笑', '原文': '欢迎[我]归来' });
    const kag = { stat: { charas: { actor: { map_face: { '笑顔': {} } } }, map_label: {} },
      parser: { parseScenario() { return { array_s: [text('原文'), emb('f.x'), { name: 'label', pm: { label_name: 'end' } }], map_label: { end: { index: 2 } } }; } },
      ftag: { master_tag: { chara_face: { start(pm) { return pm.face; } } }, convertEntity(pm) { return pm; } },
      menu: { loadGameData(data) { expect(this).toBe(kag.menu); return data; } }, evalScript(code) { expect(this).toBe(kag); return code; }, embScript(code) { return code; },
      loadScenario(file, cb) { const res = this.parser.parseScenario(); this.stat.map_label = res.map_label; cb(res.array_s); return 7; } };
    expect(install(kag, d)).toBe(true); expect(install(kag, d)).toBe(false);
    expect(kag.evalScript("f.x='青い石'")).toBe('f.x="蓝色宝石"'); expect(kag.embScript("'青い石'")).toBe('"蓝色宝石"');
    expect(kag.ftag.convertEntity({ text: "&'青い石'" }).text).toBe('&"蓝色宝石"');
    const state = { stat: { f: { random: ['青い石', '笑顔'] } } }; expect(kag.menu.loadGameData(state).stat.f.random).toEqual(['蓝色宝石', '笑顔']);
    expect(kag.ftag.master_tag.chara_face.start({ face: '新表情' })).toBe('新表情'); expect(d.faceIds.has('新表情')).toBe(true);
    expect(kag.loadScenario('any.ks', arr => { expect(arr.length).toBe(4); expect(kag.stat.map_label.end.index).toBe(3); })).toBe(7);
  });
  test('显示路径翻译动态文本，原型标签能在初始化前安装', () => {
    const kag = { tag: { text: { showMessage(value) { expect(this).toBe(kag.tag.text); return value; } }, chara_face: { start(pm) { return pm; } } }, ftag: { master_tag: {}, convertEntity(pm) { return pm; } }, menu: {} };
    const d = compileDictionary({ '観測': '观测', '待機': '等待', '青い石': '蓝色宝石' }); install(kag, d);
    expect(kag.tag.text.showMessage('観測：待機')).toBe('观测：等待');
    expect(kag.ftag.convertEntity({ text: '観測：待機', storage: '青い石' })).toEqual({ text: '观测：等待', storage: '青い石' });
    kag.tag.chara_face.start({ face: '青い石' }); expect(d.isSafeJsLiteral('青い石')).toBe(false);
  });
  test('浏览器脚本可直接执行并在引擎原型初始化前安装', () => {
    const kag = { ftag: {}, menu: {}, loadScenario() {} }, host = { document: {}, tyrano: { plugin: { kag } }, setTimeout() { throw Error('不应等待'); }, XMLHttpRequest: class { open() {} send() { this.status = 0; this.responseText = '{"空":"天空"}'; } }, console };
    const source = fs.readFileSync(path.join(__dirname, '../src/engines/tyrano/runtime-inject.js'), 'utf8'); vm.runInNewContext(source, { window: host }); expect(kag.__mtoolEmbedInstalled).toBe(true);
  });
});
describe('ASAR 无解包尾追加', () => {
  test('header、局部读取、旧文件 offset 保留与块级 integrity', async () => {
    const file = path.join(temp(), 'app.asar'); makeArchive(file, { 'a.txt': 'old', 'nested/b.txt': 'unchanged' });
    const before = asar.readHeader(file); await asar.appendFiles(file, { 'a.txt': 'new content', 'c.txt': 'new file' });
    const after = asar.readHeader(file); expect(asar.readFile(file, 'a.txt').toString()).toBe('new content'); expect(asar.readFile(file, 'nested/b.txt').toString()).toBe('unchanged');
    expect(asar.getEntry(after.header, 'nested/b.txt').offset).toBe(asar.getEntry(before.header, 'nested/b.txt').offset);
    const entry = asar.getEntry(after.header, 'a.txt'); expect(entry.integrity).toEqual(asar.integrity(Buffer.from('new content')));
    expect(Number(entry.offset)).toBe(Buffer.byteLength('oldunchanged'));
    const multi = Buffer.alloc(asar.BLOCK_SIZE + 1, 5), integrity = asar.integrity(multi); expect(integrity.blocks.length).toBe(2); expect(integrity.hash).toBe(crypto.createHash('sha256').update(multi).digest('hex'));
  });
  test('unpacked 小文件读取校验大小，尾追加后不再依赖外置文件', async () => {
    const file = path.join(temp(), 'app.asar'), header = { files: { 'a.txt': { size: 3, unpacked: true } } };
    fs.writeFileSync(file, asar.encodeHeader(header)); fs.mkdirSync(file + '.unpacked'); fs.writeFileSync(path.join(file + '.unpacked', 'a.txt'), 'old');
    expect(asar.readFile(file, 'a.txt').toString()).toBe('old'); await asar.appendFiles(file, { 'a.txt': 'new' }); expect(asar.readFile(file, 'a.txt').toString()).toBe('new'); expect(asar.getEntry(asar.readHeader(file).header, 'a.txt').unpacked).toBeUndefined();
  });
  test('拒绝坏 header、越界、小文件限制与路径穿越', async () => {
    const file = path.join(temp(), 'app.asar'); fs.writeFileSync(file, 'invalid'); expect(() => asar.readHeader(file)).toThrow(); makeArchive(file, { 'a.txt': 'abc' });
    expect(() => asar.readFile(file, 'a.txt', 2)).toThrow(); expect(() => asar.readFile(file, '../a.txt')).toThrow(); expect(() => asar.readFile(file, 'absent')).toThrow();
    await expect(asar.appendFiles(file, { '__proto__/x': 'bad' })).rejects.toThrow();
    const header = { files: { 'a.txt': { size: 3, offset: '99999' } } }; fs.writeFileSync(file, asar.encodeHeader(header)); expect(() => asar.readFile(file, 'a.txt')).toThrow('越界');
  });
});
describe('布局检测、幂等注入与备份还原', () => {
  test.each(['directory', 'asar'])('%s 首次备份、重复注入不增大、更新词典与完整还原', async kind => {
    const dir = game(kind), archive = path.join(dir, 'resources/app.asar'), original = kind === 'asar' ? fs.readFileSync(archive) : null;
    expect(tyrano.inspect(dir).injected).toBe(false); const result = await tyrano.inject(dir); expect(result.injected).toBe(true); expect(result.changed.length).toBe(kind === 'asar' ? 5 : 4);
    const size = kind === 'asar' ? fs.statSync(archive).size : 0;
    expect((await tyrano.inject(dir)).changed).toEqual([]); if (kind === 'asar') expect(fs.statSync(archive).size).toBe(size);
    fs.writeFileSync(path.join(dir, '翻译文件.json'), '{"星の海":"星辰海洋"}'); expect((await tyrano.inject(dir)).changed).toEqual(kind === 'asar' ? ['翻译文件.json'] : []);
    const restored = tyrano.restore(dir); expect(restored.restored).toBe(true); expect(tyrano.inspect(dir).injected).toBe(false);
    if (kind === 'asar') expect(fs.readFileSync(archive).equals(original)).toBe(true);
    else { for (const [name, value] of Object.entries(baseFiles())) expect(fs.readFileSync(path.join(dir, name)).equals(Buffer.from(value))).toBe(true); expect(fs.existsSync(path.join(dir, 'mtool-embed-runtime.js'))).toBe(false); }
    expect(fs.readFileSync(path.join(dir, '翻译文件.json'), 'utf8')).toBe(kind === 'asar' ? '{"星の海":"星辰海洋"}' : JSON.stringify({ '星の海': '星之海' }));
    expect(tyrano.restore(dir).restored).toBe(true); expect((await tyrano.inject(dir)).injected).toBe(true);
  });
  test('resources/app 布局和自定义词典', async () => {
    const dir = temp(), root = path.join(dir, 'resources/app');
    for (const [name, value] of Object.entries(baseFiles())) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value); }
    const dictionary = path.join(dir, 'custom.json'); fs.writeFileSync(dictionary, '{"空":"天空"}'); expect(tyrano.detect(dir).root).toBe(root);
    expect((await tyrano.inject(dir, { dictionary })).injected).toBe(true); tyrano.restore(dir); expect(fs.existsSync(path.join(root, '翻译文件.json'))).toBe(false);
  });
  test('损坏备份拒绝还原，恶意清单拒绝读取', async () => {
    const dir = game(); await tyrano.inject(dir); fs.writeFileSync(path.join(dir, '.mtool-embed/0'), 'bad'); expect(() => tyrano.restore(dir)).toThrow('校验失败');
    const file = path.join(dir, '.mtool-embed/manifest.json'), manifest = JSON.parse(fs.readFileSync(file)); manifest.files[0].path = '../escape'; fs.writeFileSync(file, JSON.stringify(manifest)); expect(() => tyrano.restore(dir)).toThrow('不安全');
  });
  test('缺词典与无效词典在修改之前失败', async () => {
    const dir = game(); fs.writeFileSync(path.join(dir, '翻译文件.json'), '[]'); await expect(tyrano.inject(dir)).rejects.toThrow(); expect(fs.existsSync(path.join(dir, '.mtool-embed'))).toBe(false);
    fs.unlinkSync(path.join(dir, '翻译文件.json')); await expect(tyrano.inject(dir)).rejects.toThrow('找不到');
  });
  test('HTML/CSS/Config 幂等且保留原有字体与脚本', () => {
    const html = '<body><script src="existing.js"></script></body>'; expect(tyrano.injectHtml(tyrano.injectHtml(html))).toBe(tyrano.injectHtml(html)); expect(tyrano.injectHtml(html)).toContain('existing.js');
    expect(tyrano.injectCss(tyrano.injectCss('css'))).toBe(tyrano.injectCss('css'));
    expect(tyrano.injectCss(tyrano.injectCss('css') + '.user-added { color: red; }')).toContain('.user-added { color: red; }');
    const config = ';userFace=Original Font // note\r\n;defaultFontSize=28\r\n'; const patched = tyrano.injectConfig(config); expect(tyrano.injectConfig(patched)).toBe(patched); expect(patched).toContain('Original Font'); expect(patched).toContain(';defaultFontSize=28');
  });
});
describe('CLI Node 与 Bun 兼容', () => {
  test('inject / inspect / restore 命令与错误参数', async () => {
    const dir = game(), outputs = [], io = { log(s) { outputs.push(JSON.parse(s)); } };
    expect(await main(['inspect', dir], io)).toBe(0); expect(outputs.at(-1).injected).toBe(false);
    await main(['inject', dir], io); expect(outputs.at(-1).injected).toBe(true); await main(['restore', dir], io); expect(outputs.at(-1).restored).toBe(true);
    await expect(main(['inject', dir, '--wrong', 'x'], io)).rejects.toThrow('无效'); await expect(main(['inspect', dir, '--engine', 'unknown'], io)).rejects.toThrow('未识别');
  });
  test('真实子进程 Node inspect、帮助与错误退出码', () => {
    const dir = game(), bin = path.join(__dirname, '../bin/mtool-embed.js');
    let res = spawnSync('node', [bin, 'inspect', dir], { encoding: 'utf8' }); expect(res.status).toBe(0); expect(JSON.parse(res.stdout).engine).toBe('tyrano');
    res = spawnSync('node', [bin, '--help'], { encoding: 'utf8' }); expect(res.status).toBe(0); expect(res.stdout).toContain('restore');
    res = spawnSync('node', [bin, 'invalid', dir], { encoding: 'utf8' }); expect(res.status).toBe(1); expect(res.stderr).toContain('参数错误');
  });
});
