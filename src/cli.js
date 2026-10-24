'use strict';
const fs = require('node:fs');
const path = require('node:path');
// 后续引擎实现同一 detect / inspect / inject / restore 接口后在此注册。
const engines = [require('./engines/tyrano')];
const HELP = `mtool-embed <inject|restore|inspect> <游戏目录> [--dictionary <翻译文件.json>] [--engine tyrano]

inject   嵌入浏览器运行时、词典和中文字体回退，首次修改前备份
restore  使用经过 SHA256 校验的首次备份还原，保留备份
inspect  只读检查游戏布局、注入状态与词典位置

支持 resources/app.asar、resources/app 与直接包含 index.html 的目录。
路径含空格时请使用引号。运行时优先读取游戏外置翻译文件，失败后读取内置词典。
`;
async function main(argv = process.argv.slice(2), io = console) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { io.log(HELP); return 0; }
  const [command, game, ...rest] = argv;
  if (!['inject', 'restore', 'inspect'].includes(command) || !game || game.startsWith('--')) throw new Error('参数错误，请使用 --help 查看用法');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--dictionary', '--engine'].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`无效参数: ${rest[i]}`);
    const key = rest[i].slice(2);
    if (options[key]) throw new Error(`重复参数: ${rest[i]}`);
    options[key] = rest[i + 1];
  }
  if (options.dictionary && command !== 'inject') throw new Error('--dictionary 只用于 inject');
  const root = path.resolve(game);
  let engine;
  if (options.engine) engine = engines.find(e => e.id === options.engine);
  else if (command === 'restore' && fs.existsSync(path.join(root, '.mtool-embed/manifest.json'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.mtool-embed/manifest.json'), 'utf8'));
    engine = engines.find(e => e.id === manifest.engine);
  } else engine = engines.find(e => e.detect(root));
  if (!engine) throw new Error('未识别支持的引擎，请检查目录或使用 --engine tyrano');
  io.log(JSON.stringify(await engine[command](root, options), null, 2));
  return 0;
}
module.exports = { main, engines };
