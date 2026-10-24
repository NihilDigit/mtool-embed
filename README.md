# mtool-embed

将 MTool 的 `翻译文件.json` 嵌入游戏，使游戏在不启动 MTool 的情况下加载译文。当前支持 TyranoScript，CLI 通过引擎适配接口预留其他引擎的扩展位置。

使用 Node.js 18+ 或 Bun，无外部运行时依赖。不分发游戏资源或字体。源码不包含特定游戏的台词、变量名或路径匹配规则。

## 使用

在本仓库目录执行：

```bash
node bin/mtool-embed.js inspect "D:/Games/Example"
node bin/mtool-embed.js inject "D:/Games/Example"
node bin/mtool-embed.js inject "D:/Games/Example" --dictionary "D:/Translations/翻译文件.json"
node bin/mtool-embed.js restore "D:/Games/Example"
```

也可将 `node` 换成 `bun`。`npm link` 或 `bun link` 后可直接使用 `mtool-embed`。使用 `--engine tyrano` 显式选择引擎，`--help` 查看帮助。成功退出码为 0，参数、检测、读写或校验失败退出码为 1，错误写到 stderr。正常结果为 JSON。

注入和还原前退出游戏。工具不会启动、重启或终止游戏进程。`inspect` 只读取文件，不修改游戏。

## 支持的目录

指定游戏可执行文件所在目录，或直接指定网页应用目录：

```text
Example/
  game.exe
  翻译文件.json
  resources/
    app.asar
```

```text
Example/
  game.exe
  翻译文件.json
  resources/app/
    index.html
    tyrano/
    data/system/Config.tjs
```

也支持游戏目录下的 `app.asar`、`app/`，或游戏目录本身包含 `index.html`、`tyrano/` 和 `data/system/Config.tjs`。不支持加密、压缩或自定义容器，也不修改 Electron 可执行文件的签名和安全 fuse。

## 注入原理

1. 读取并验证词典，生成独立的 `mtool-embed-runtime.js`，通过带边界标记的 script 标签加入 `index.html`，保留已有脚本。
2. 向 `tyrano/css/font.css` 添加中文字体回退规则，并扩充 `Config.tjs` 中的 `userFace` / `defaultFont` 字体列表。使用系统已有字体，不修改字号。
3. 将词典复制到应用根目录。运行时优先尝试 `window.studio_api.fs_default` 或 `window.require('fs')` 读取可执行文件同级词典，然后读取工作目录词典；失败时通过同步 XHR 读取内置 `./翻译文件.json`。纯浏览器只使用内置词典。词典在本次页面启动时编译，修改外置词典后重新打开游戏生效。
4. 对剧本解析结果进行 AST 重写，并对脚本字面量、动态显示文本和载入存档中的字符串应用通用规则。

词典是原文到译文的平面 JSON 对象，例如：

```json
{
  "こんにちは": "你好",
  "準備中": "准备中"
}
```

非字符串译文忽略。支持精确匹配、去空白匹配、从破损 `&` / `+` 表达式中对齐恢复字符串字面量、括号前后缀模板、冒号分段、数字量词、倍数和音符段。所有推导来自词典或语言级结构，不按游戏名和变量名分支。

### 剧本和存档

- 对明确满足结构和动词约束的 `text + emb + text` 与五节点来源/数量结构重排量词和宾语。
- 识别译文中的主角占位符或中文单空格占位，将相邻 `emb` 放回占位位置。
- 对日文格助词与中文介词“的”的组合做局部重排。
- AST 变化后重算 label 节点及 `map_label` 的索引，保持回调和节点表达式不变。同一剧本数组只转换一次。
- hook `evalScript`、`convertEntity` / `embScript`，不执行输入词典的代码，只替换精确命中的安全字面量。跳过文件路径、常见资源扩展名、ASCII 内部标识符及已注册表情 ID。字符串解码不使用 `eval`。
- 在 `loadGameData` 读取 `data.stat.f` 时递归翻译所有数组和纯对象内的安全字符串，不依赖任何游戏变量名；跳过 getter、非纯对象与循环引用。

这些规则不是任意日文的机器翻译。缺乏明确结构、无对应词典项的内容保持原样。代码扫描器保守跳过含 `${...}` 的模板字面量、注释和正则，不是完整 JavaScript parser。任意脚本中字符串的业务含义无法由通用算法完全证明，特殊脚本及插件需在游戏内复核。

## ASAR 与备份

ASAR 仅读取 header 和需要修改的小文件，不全量解包。替换时保留旧文件 offset，流式复制原始数据区，在尾部追加修改文件并更新 header。新增或修改的文件生成 SHA256 整体 hash 与 4 MiB 分块 integrity。使用同目录临时文件和 rename 替换 archive。需要足够的磁盘空间同时保存原包、首次备份和写入中的临时包。

首次修改前在游戏目录创建 `.mtool-embed/manifest.json` 和编号备份：

- ASAR 备份原包，restore 按 SHA256 校验后原样还原。
- 未打包目录备份工具涉及的五个文件，包含文件是否原本存在的信息；restore 恢复原文件并移除工具新建文件。
- 重复 inject 不覆盖首次备份，相同内容不重写或尾追加；仅词典或运行时变化时追加有变化的文件。
- restore 保留备份，可重复执行。不要手工修改备份清单与编号文件。
- 工具备份范围以外的文件不还原。在未打包应用根目录中，外置词典和内置词典可能是同一文件，此时 restore 也会恢复该词典首次备份的内容。ASAR 外部的词典不在 archive 备份范围内。

首次备份被保留意味着后续游戏升级后不能继续沿用旧备份，否则还原会回到升级前。升级前先还原并将备份另行归档，再重新注入。工具不自动修复其他注入工具的修改，不保证 Electron archive 完整性 fuse、签名验证或第三方插件与本工具兼容。

ASAR 替换是单文件原子操作；未打包目录涉及多次原子文件替换，进程中断可能留下部分注入，可用 restore 还原。首次备份中断且清单未完成时，工具会拒绝继续，需人工检查备份。

## 开发与验证

```bash
bun test
node bin/mtool-embed.js --help
```

测试通过合成游戏目录和 ASAR 覆盖词典编译、安全字面量、AST 重排、标签索引、存档递归、运行时 hook、流式归档追加、块级 integrity、幂等注入和字节级还原；测试不会修改真实游戏或启动游戏窗口。

引擎适配器导出 `id`、`detect(game)`、`inspect(game)`、`inject(game, options)` 和 `restore(game)`。后续引擎在 `src/cli.js` 的 `engines` 注册，不需修改通用 CLI 或 ASAR 操作。
