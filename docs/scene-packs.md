# 场景分包与远程加载

适用于 Godot 4.7.2、GDScript、Compatibility，以及本仓库带 `--extra-pack` 支持的微信引擎。插件输出 JSON 清单和 Brotli 压缩包，不上传资源、不组装或发布微信工程。

## 安装与配置

执行 `python tools/package_plugin.py` 生成 `dist/scene-packer-plugin.zip`，在 Godot 的 AssetLib 中导入本地 ZIP，保留 `addons/scene_packer/` 路径。在“项目设置 → 插件”中启用“场景分包”，打开底部同名面板。

1. 在“导出设置”页填写稳定的项目标识。插件 3.0.0 起导出整个项目，不再设置“入口场景”，也不覆盖工程的启动场景。
2. 在“资源分包”页左侧添加、选择资源包，右侧勾选文件夹或单个文件。顶部筛选框可按文件名或路径查找资源。勾选或取消目录会联动全部子项；子项可以单独反选，父目录显示半选状态，全部选中后恢复全选。筛选时操作目录也作用于未显示的子项。目录内以后新增文件自动纳入，明确排除的文件或子目录除外。
3. 为全部游戏场景及运行资源配置归属。同一个文件不能跨包重复选择。所有 `.tscn`/`.scn` 场景及所有包都会参与检查，包括独立关卡和未被其他包引用的资源包；未分配场景、未分配依赖、缺失资源和包间循环会阻止导出。
4. 动态拼接路径无法静态推断：将目标资源加入包，选中使用者包，在“导出设置 → 包附加依赖”填写包名，多个名称用逗号分隔。输入框下方会显示当前正在编辑哪个包。
5. 在“导出设置”页配置 Brotli 命令行程序和输出目录。程序路径留空时从 PATH 查找；也可点击“浏览…”选择。点击“选择父目录…”会在该目录下填入一个新的时间戳版本目录。压缩等级固定为 11，不需要 Python。
6. 勾选变化后自动保存并更新归属、文件数量、依赖、体积和验证结果，保留当前页签与展开位置。点击底部“分析依赖”可立即打开“分析结果”页查看完整引用链和具体问题；附加依赖输入框按回车或离开后也会更新分析。确认后点击“导出 .pck.br”。导出完成后，表格更新为 PCK 和 Brotli 大小，悬停 Brotli 列查看压缩比例。

三个页签分别处理资源分配、导出设置和结果查看，底部始终保留保存、分析与导出操作。资源列表和结果区域可拖动分隔线调整大小；资源树中的长路径可悬停查看完整内容。旧版插件使用 JSON 配置框和“微信引擎工程”输入项；使用新布局需要在对应工程安装当前 ZIP 并重新启用插件。

包定义保存在项目内的 `scene_packs.json`，可纳入版本控制；Brotli 路径保存在本机编辑器设置中。导出在独立无窗口进程中完成，界面显示进度和错误。导出期间修改源文件会使本次导出失败。

每个包的 `paths` 保存包含规则，选中目录后反选子项会写入可选的 `excludes` 数组。例如 `"paths": ["res://assets"], "excludes": ["res://assets/drafts"]` 会保留 assets 下的其他资源及新增文件。更具体的路径规则优先，同路径排除优先；在已排除目录内重新勾选文件，会写入更具体的包含规则。再次操作父目录会清除该目录下的子级例外。插件 2.2.0 起支持这些规则，旧配置无需修改；包含 `excludes` 的配置应使用 2.2.0 或更新插件导出。

插件会同步外部修改的 `scene_packs.json`，保存和分析前也会核对磁盘版本，避免旧面板数据覆盖修复。同一字段发生编辑冲突或磁盘 JSON 无效时停止保存，不改动磁盘文件。需要主动刷新时，在“导出设置 → 配置文件”点击“重新读取”；面板中有未保存修改时会先确认是否放弃这些修改。

每次导出全部配置的包。假设 A → B → C，另有独立 X，发布目录会包含 A/B/C/X；运行 A 时按依赖加载 A/B/C，运行 X 时只加载 X 及公共启动资源。加载粒度是包：同包里的其他场景和资源也会一起下载。项目图标、Autoload 等同样需要分配归属，它们所属包及依赖属于公共启动数据。

缓存、构建目录、`.gdignore` 目录和插件自身不参与扫描。`addons/` 下带 `plugin.cfg` 的编辑器插件面板不会自动作为游戏场景要求分包；开发者显式分配的插件资源、游戏引用到的插件资源及工程默认场景仍会检查。旧 `scene_packs.json` 的 `entry_scene` 不再参与分析，面板保存时会移除该字段。

## 产物与协议

```text
release/
├── manifest.json
└── packs/
    ├── bootstrap-<sha256>.pck.br
    ├── a-<sha256>.pck.br
    ├── b-<sha256>.pck.br
    └── c-<sha256>.pck.br
```

`bootstrap` 是保留包名，包含导出项目设置、UID/全局类索引和场景就绪通知脚本。业务资源仍在开发者指定的包中。临时 PCK、导入副本和解压校验文件不进入发布目录。

清单 `schema: 3` 包含 `project_id`、`engine_version`、`bootstrap`、全项目的 `scene_to_pack`、`packs` 和 `release_id`。`project_scene` 仅记录引擎原有的默认启动场景，可为空；`scene_override` 记录工程是否允许运行时配置覆盖，均从 `project.godot` 自动读取。清单不再含 `entry_scene`。每个包记录相对 `url`、`compression: "br"`、`depends`、原始 `files`、实际 `archive_files`，以及压缩和解压两份数据的 SHA-256 与字节数。资源仍使用原来的 `res://` 路径。

`release_id` 为去掉该字段后，递归按对象键排序、无空白 JSON 的 UTF-8 SHA-256；数组顺序保留。文件名使用压缩内容的完整 SHA-256。清单的包依赖必须是有向无环图。

导出采用官方 Web 资源转换，保留导入纹理、GLB、编译脚本及重映射。导出副本关闭文本场景到二进制的转换，保留场景之间的引用，避免 Godot 在转换时把 B 的变换属性写入 A，导致只修改 B 也要重新下载 A。Godot 4.7 的场景节点恢复 ID 会在重新导入时随机生成；插件在隔离导出产物中统一规范化这些 ID 及其关联 ID 路径，再打包，避免未改变内容的包产生无意义更新。不会修改源场景。

## 微信接入

先使用当前补丁重新构建引擎；3D 项目需要 `--enable-3d`。已应用旧补丁的源码目录受保护，需要用新的 `--source` 目录依次执行 `fetch`、`apply`、`build`，并在 `package` 中使用同一目录。

```text
python build.py package --manifest-url https://cdn.example.com/game/manifest.json --output dist/manifest-game
```

该命令只写入清单 URL 和引擎版本，不下载或包含游戏包。填写输出工程 AppID 后导入微信开发者工具。配置模块的模式为 `manifest`，参数为 `manifest_url` 和 `engine_version`；默认按工程原有启动设置运行。原有 `local`、`remote`、`bundled_br`、schema-1 分包接口及 schema-2 清单继续保留。

升级插件 3.0.0 时需要更新宿主的 `engine/manifest-packs.js` 和 `engine/godot-sdk.js`，并重新导出包含场景加载桥接脚本的启动包。已有支持 `--extra-pack` 的引擎可复用，无需为此次升级重新编译 WASM。

服务器先上传所有 `.pck.br`，最后发布清单，保持相对目录结构。建议使用 `Content-Type: application/octet-stream`；不要设置 `Content-Encoding: br`，客户端需要取得原始压缩字节并自行解压。清单应及时刷新缓存。清单域名加入微信 request 合法域名，压缩包域名加入 downloadFile 合法域名。

启动时最多并发下载 3 个包，同包请求合并。压缩字节经过大小和 SHA-256 校验后解压，再检查 PCK 头、引擎版本和 SHA-256。所有依赖准备完成才初始化游戏。JS 把启动包和附加包写入虚拟文件系统，通过 `--main-pack` 和可重复的 `--extra-pack` 参数启动；引擎在读取项目设置和初始化 Autoload 前挂载全部包。

## 选择和切换运行场景

宿主可以在 `engine/pack-config.js` 的清单模式配置中添加 `scene`，为本次运行选择任意已导出的场景：

```js
export default {
    mode: "manifest",
    manifest_url: "https://cdn.example.com/game/manifest.json",
    engine_version: "4.7.2",
    scene: "res://levels/level_02.tscn"
};
```

省略 `scene` 时沿用 Godot 工程原有默认场景。工程没有默认场景也能导出，但宿主启动时必须提供 `scene`。显式选择通过虚拟文件系统中的临时 `override.cfg` 交给引擎，不修改源工程或缓存 PCK。若工程设置了 `application/config/disable_project_settings_override=true`，不能在启动时覆盖默认场景，可在启动后切换。

游戏运行中可调用：

```js
await GameGlobal.GODOTSDK.loadScene("res://levels/level_03.tscn", progress => {
    console.log(progress.stage, progress.pack, progress.percent);
});
```

返回的 Promise 在依赖下载、校验、解压、挂载及场景就绪后完成；失败会拒绝，可显示错误并重试。相同场景的并发请求合并，不同场景请求按顺序执行。已经挂载的包会复用。直接调用 Godot 的 `change_scene_to_file` 不会触发远程下载，尚未挂载的场景应通过该接口加载。

GDScript 可通过导出副本内的 Autoload 桥接节点请求，并监听完成或失败信号：

```gdscript
var loader := get_node("/root/__ScenePackReady")
loader.scene_loaded.connect(_on_scene_loaded)
loader.scene_load_failed.connect(_on_scene_load_failed)
loader.load_scene("res://levels/level_03.tscn")
```

桥接节点由导出流程注入，普通编辑器运行不自动创建它；开发时可用 `get_node_or_null` 检查并走本地场景切换。不要把等待切换的逻辑仅保存在即将被释放的旧场景节点上。

## 缓存、更新与故障

磁盘只缓存 `.br`，解压 PCK 仅保留于本次运行的虚拟文件系统。缓存按清单地址隔离，再按项目、引擎版本和包哈希区分。每次启动请求清单，同次运行固定使用同一份清单，不执行运行中热替换。

只修改 B 时复用 A/C，仅在需要 B 时下载新版 B。启动场景就绪后原子提交成功清单，删除新清单已不再引用的旧缓存；本版本其他场景的已有缓存保留。启动前网络、校验或解压失败时，只能整体回退到所选场景依赖缓存完整的上次成功版本。启动失败保留旧版本，不在同一进程中混挂新旧包。

运行中切换场景始终使用启动时固定的清单，不重新请求新版本，也不回退到其他清单。下载或解压失败时保留当前场景，可以重试；挂载或引擎切换失败后要求重启，避免继续使用状态不确定的引擎。离线回退会话仅使用旧清单对应的已有缓存，未缓存关卡会明确失败。

缓存文件损坏时联网重新下载；断网且缓存不完整时明确报错。首次启动必须联网。哈希用于完整性检查，不替代 HTTPS 和发布服务器的访问控制。

## 后台验证

```text
python tools/test.py
python tools/verify_plugin_panel.py --godot <Godot-console-executable>
python tools/verify_scene_export.py --godot <Godot-console-executable> --brotli <Brotli-executable>
node tools/validate_scene_manifest.js <release-directory>/manifest.json
python tools/verify_manifest_web.py --host <packaged-wechat-project> --release <release-directory> --brotli <Brotli-executable>
```

面板检查通过后台编辑器的鼠标输入验证父子联动、半选、筛选后的整目录选择、即时数量与分析更新，以及外部配置同步和旧入口字段迁移。真实导出检查构造 A/B/C、独立 X、未引用资源包、PNG、GLB、Shader、全局脚本和 Autoload，验证全项目检查、编辑器插件排除、无默认场景导出、子项排除、并发导出哈希一致、只修改 B、隔离加载和压缩回读。所有 Godot 检查使用 `--headless`，Windows 子进程隐藏控制台。

`verify_manifest_web.py` 另需 Python Playwright 和 Microsoft Edge。它在无窗口浏览器内运行实际编译的 3D WebAssembly 引擎，使用模拟 wx 文件系统和本地路由，确认压缩包通过真实加载器挂载、场景就绪且成功清单已提交。使用 `--scene res://x/X.tscn --then-scene res://a/A.tscn --then-scene res://x/X.tscn` 验证任意场景启动与运行中切换、依赖补载及不重复下载。输出日志在 `build/manifest-web-verification/`；使用 `--output` 可更换目录。所有资源来自导出版本，不允许读取源工程补齐缺失文件。

JS 回归验证依赖顺序、并发限制、压缩缓存、损坏重下载、版本提交失败、整版离线回退及禁止混版。模拟微信接口和无头 Godot 不能代替微信宿主与 Android/iOS 真机验收。

已执行的检查、产物标识及未测范围见[验证记录](scene-packs-validation.md)。
