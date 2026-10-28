# 场景分包与远程加载

插件不设置固定的 Godot 版本限制；以下 GDScript、Compatibility 导出流程已在 Godot 4.7 验证。插件输出 JSON 清单和 Brotli 压缩包，不上传资源、不组装或发布微信工程。使用其他版本时需具备对应的 Web 导出模板，微信宿主的引擎版本仍须与导出清单中的 `engine_version` 一致。

## 安装与配置

执行 `python tools/package_plugin.py` 生成 `dist/scene-packer-plugin.zip`，在 Godot 的 AssetLib 中导入本地 ZIP，保留 `addons/scene_packer/` 路径。在“项目设置 → 插件”中启用“场景分包”，打开底部同名面板。

1. 在“导出设置”页填写稳定的项目标识。插件 3.0.0 起导出整个项目，不再设置“入口场景”，也不覆盖工程的启动场景。
2. 在“资源分包”页左侧添加、选择资源包，右侧勾选文件夹或单个文件。顶部筛选框可按文件名或路径查找资源。勾选或取消目录会联动全部子项；子项可以单独反选，父目录显示半选状态，全部选中后恢复全选。筛选时操作目录也作用于未显示的子项。其他包已选中的文件在当前包不可勾选；目录只要含有这类文件，就禁用目录复选框，但仍可展开并单独选择未占用的子项。已有重复归属的单文件仍可从当前包取消勾选。目录内以后新增文件自动纳入，明确排除的文件或子目录除外。
3. 为全部游戏场景及运行资源配置归属。同一个文件不能跨包重复选择；外部编辑配置造成的重复归属仍会由分析器报告。所有 `.tscn`/`.scn` 场景及所有包都会参与检查，包括独立关卡和未被其他包引用的资源包；未分配场景、未分配依赖、缺失资源和包间循环会阻止导出。
4. 动态拼接路径无法静态推断：将目标资源加入包，选中使用者包，在“导出设置 → 包附加依赖”填写包名，多个名称用逗号分隔。输入框下方会显示当前正在编辑哪个包。
5. 在“导出设置”页配置 Brotli 命令行程序和输出目录。程序路径留空时从 PATH 查找；也可点击“浏览…”选择。点击“选择父目录…”会在该目录下填入一个新的时间戳版本目录。压缩等级固定为 11，不需要 Python。
6. 勾选变化后立即保存并更新归属和文件数量，保留当前页签、展开位置与选中行；依赖、体积和验证结果会在短暂延迟后自动更新，连续勾选合并为一次分析。点击底部“分析依赖”可立即打开“分析结果”页查看完整引用链和具体问题；附加依赖输入框按回车或离开后也会更新分析。确认后点击“导出 .pck.br”。“分析结果”页会显示当前阶段和已完成步骤；每个资源包完成压缩与校验后前进一步。该进度按步骤计算，不表示预计耗时。导出完成后，表格更新为 PCK 和 Brotli 大小，悬停 Brotli 列查看压缩比例。

三个页签分别处理资源分配、导出设置和结果查看，底部始终保留保存、分析与导出操作。资源列表和结果区域可拖动分隔线调整大小；资源树中的长路径可悬停查看完整内容。旧版插件使用 JSON 配置框和“微信引擎工程”输入项；使用新布局需要在对应工程安装当前 ZIP 并重新启用插件。

包定义保存在项目内的 `scene_packs.json`，可纳入版本控制；Brotli 路径保存在本机编辑器设置中。导出在独立无窗口进程中完成，界面显示阶段、步骤进度和错误；失败时保留最后完成的步骤。导出期间修改源文件会使本次导出失败。

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

清单 `schema: 4` 包含 `project_id`、`engine_version`、`bootstrap`、全项目的 `scene_to_pack`、`packs` 和 `release_id`。`project_scene` 仅记录引擎原有的默认启动场景，可为空；`scene_override` 记录工程是否允许运行时配置覆盖，均从 `project.godot` 自动读取。清单不再含 `entry_scene`。新增 `startup_mode: "direct" | "godot_loading"`，取自项目设置 `scene_packer/startup_mode`，默认 `direct`。每个包记录相对 `url`、`compression: "br"`、`depends`、原始 `files`、实际 `archive_files`，以及压缩和解压两份数据的 SHA-256 与字节数。资源仍使用原来的 `res://` 路径。

`release_id` 为去掉该字段后，递归按对象键排序、无空白 JSON 的 UTF-8 SHA-256；数组顺序保留。文件名使用压缩内容的完整 SHA-256。清单的包依赖必须是有向无环图。

导出采用官方 Web 资源转换，保留导入纹理、GLB、编译脚本及重映射。导出副本关闭文本场景到二进制的转换，保留场景之间的引用，避免 Godot 在转换时把 B 的变换属性写入 A，导致只修改 B 也要重新下载 A。Godot 4.7 的场景节点恢复 ID 会在重新导入时随机生成；插件在隔离导出产物中统一规范化这些 ID 及其关联 ID 路径，再打包，避免未改变内容的包产生无意义更新。不会修改源场景。

## 微信接入

先使用当前补丁重新构建引擎；3D 项目需要 `--enable-3d`。已应用旧补丁的源码目录受保护，需要用新的 `--source` 目录依次执行 `fetch`、`apply`、`build`。`package` 未指定 `--source` 时会自动选择唯一匹配当前适配版本的已构建目录；若有多个匹配目录，则须显式指定 `--source`。

```text
python build.py package --manifest-url https://cdn.example.com/game/manifest.json --output dist/manifest-game
```

该命令只写入清单 URL 和引擎版本，不下载或包含游戏包。填写输出工程 AppID 后导入微信开发者工具。配置模块的模式为 `manifest`，参数为 `manifest_url` 和 `engine_version`；默认按工程原有启动设置运行。原有 `local`、`remote`、`bundled_br`、schema-1 分包接口及 schema-2/3 清单继续保留。

清单地址允许固定的 HTTP 或 HTTPS `.json` URL。局域网调试时，地址需能从开发者工具访问，并在项目设置中关闭“校验合法域名”：

```text
python build.py package --source build/godot-4.7.2-manifest --manifest-url http://192.168.1.10:9000/manifest.json --output dist/manifest-lan
```

需要在调试时加载同一 Godot 主次版本、由较早补丁版本导出的资源包，可额外加 `--local-manifest-dev`；例如 4.7.2 宿主可尝试加载 4.7.0 PCK。正式发布需遵守微信平台的域名与协议要求，并使用匹配的引擎版本重新打包工程。`pack-pck` 仅用于单个 PCK 的固定 URL 发布，不适用于上述 `manifest.json` 多包流程。

升级插件 4.0.0 时需要更新宿主的 `engine/manifest-packs.js` 和 `engine/godot-sdk.js`，并重新导出包含场景加载桥接脚本的启动包。已有支持 `--extra-pack` 的引擎可复用，无需为此次升级重新编译 WASM。

服务器先上传所有 `.pck.br`，最后发布清单，保持相对目录结构。建议使用 `Content-Type: application/octet-stream`；不要设置 `Content-Encoding: br`，客户端需要取得原始压缩字节并自行解压。清单应及时刷新缓存。清单域名加入微信 request 合法域名，压缩包域名加入 downloadFile 合法域名。

启动时最多并发下载 3 个包，同包请求合并。压缩字节经过大小和 SHA-256 校验后解压，再检查 PCK 头、引擎版本和 SHA-256。启动依赖准备完成才初始化 Godot；加载页模式此时仅准备加载页及必要启动资源。JS 把启动包和附加包写入虚拟文件系统，通过 `--main-pack` 和可重复的 `--extra-pack` 参数启动；引擎在读取项目设置和初始化 Autoload 前挂载全部包。

## 选择和切换运行场景

直接启动模式（`direct`，以及旧 schema-2/3）中，宿主可以在 `engine/pack-config.js` 的清单模式配置中添加 `scene`，为本次运行选择任意已导出的场景：

```js
export default {
    mode: "manifest",
    manifest_url: "https://cdn.example.com/game/manifest.json",
    engine_version: "4.7.2",
    scene: "res://levels/level_02.tscn"
};
```

省略 `scene` 时沿用 Godot 工程原有默认场景。工程没有默认场景也能导出，但宿主启动时必须提供 `scene`。显式选择通过虚拟文件系统中的临时 `override.cfg` 交给引擎，不修改源工程或缓存 PCK。若工程设置了 `application/config/disable_project_settings_override=true`，不能在启动时覆盖默认场景，可在启动后切换。

示例中的 `engine_version` 应按实际导出清单填写，不要沿用与清单不同的示例值。

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

## Godot 加载页模式

项目设置示例：

```ini
[application]
run/main_scene="res://levels/loading/loading.tscn"

[scene_packer]
startup_mode="godot_loading"
initial_scene="res://levels/level_01/level_01.tscn"
```

上例适用于自动加载页。使用业务主页时，将工程 `run/main_scene` 指向主页，并以 `auto_start=false` 装配同一持久控制器；首帧之后显示主页并允许操作，点击开始才调用 `request_initial_scene()`。`home_scene` 指定返回页面，`return_home()` 不提交成功版本。scene-test 的主页实现保持 `bootstrap + boot` 启动闭包；主页美术不依赖玩家或环境实例。

隐藏浏览器验证可使用 `tools/verify_manifest_web.py --home-ui`，配合 `--host`、`--release`、`--brotli`、`--confirmed-scene` 和 `--output` 参数，保存主页、弹窗、横竖屏、安全区与进入关卡截图，并检查玩法包只在点击开始后下载。

`initial_scene` 是示例加载控制器读取的延迟目标，业务也可自行选择其他目标。分析器检查该路径存在且已分包，但不将这个设置计入启动依赖；不要在加载脚本中 `preload()` 目标场景。插件仍全项目导出、检查所有场景，不提供入口选择器。加载页模式拒绝宿主的 `scene` 字段，防止绕过加载页。

单独建立 `boot` 包，分配加载场景、控制器、图标和必需字体；不要分配玩法资源或引用玩法类。图标、Autoload、项目全局资源仍属于必要启动依赖，Autoload 若引用玩法包也会提前下载。分析结果展示启动包集合、源文件估算体积与依赖链；导出完成后显示启动压缩体积。scene-test 的启动集合应只有 `bootstrap + boot`；`gameplay`、`environment`、`shared` 在请求毒岛时才补齐。

导出副本注入的 `/root/__ScenePackReady` 提供下列接口；普通编辑器运行用 `get_node_or_null` 判断是否存在。

| 接口或信号 | 含义 |
| --- | --- |
| `prepare_scene(path) -> int` | 返回请求 ID，下载、校验、解压并挂载依赖；不加载或切换场景；同场景在途请求合并 |
| `progress(id, stage, completed, total, pack_id)` | 阶段为 download、verify、decode、mount；下载单位为压缩字节，其余为包；total=0 表示未知 |
| `packs_ready(id, path)` | 可调用 Godot ResourceLoader；控制器应忽略其他请求 ID |
| `failed(id, code, message, retryable)` | resources 可重试；engine 表示挂载状态不确定，须重启 |
| `confirm_scene_ready(path)` | 当前节点就绪且可选业务协议已通过后，等待绘制并提交成功版本 |
| `scene_confirmed(path)` / `confirmation_failed(path, message)` | 提交完成或失败；保存失败可重试，不清理旧缓存 |
| `can_rollback()` / `restart_previous()` | 检查并要求下次启动使用上次成功版本；错误通过 rollback_failed(message) 返回 |
| `rollback_scene()` | 整版回退时已确认的旧关卡；示例优先使用它 |

持久控制器的典型顺序：

```gdscript
# 在不会随旧场景释放的节点上连接信号并保存请求 ID。
var bridge = get_node_or_null("/root/__ScenePackReady")
var request_id = bridge.prepare_scene(target_path)
# packs_ready(id, path) 中核对 request_id，再执行：
ResourceLoader.load_threaded_request(target_path, "PackedScene", false)
# 每帧检查 load_threaded_get_status；LOADED 后取 PackedScene 并切换。
# 等业务准备完成和首帧绘制后：
bridge.confirm_scene_ready(target_path)
```

可编辑示例位于 `examples/godot-loading/`；交付 ZIP 包含独立示例项目和插件。scene-test 的 `levels/loading/` 是接入副本，默认进入毒岛。Node 控制器 `loading.gd` 在启动后迁移到 SceneTree 根节点，持有独立的 CanvasLayer 界面 `loading_view.tscn/.gd`；进度、错误和按钮意图通过信号连接。更换界面只需编辑 view 场景和脚本。资源准备、线程资源加载、实例化与业务预热分别处理。后续切换仍调用 `/root/SceneLoading.request_scene(path)`；再次进入启动场景会复用已有控制器，普通编辑器运行跳过远程步骤。

需要协调本地预热遮罩时，通过 `scene_loading_controller` 组获取控制器，读取 `is_loading()` 并订阅 `activity_changed(active)`。该协议不要求预热组件引用加载页类或读写根节点元数据；关卡单独运行且没有控制器时使用本地遮罩。升级示例时替换整个 `levels/loading/` 目录并重新导出 boot，避免遗漏独立 view 文件；宿主运行协议和插件版本保持兼容。

目标场景可实现 `is_ready_for_play() -> bool`、`preparation_progress(completed: int, total: int)`、`preparation_finished(success: bool, message: String)`、`retry_preparation()`，以及可选 `get_preparation_error() -> String`。若在 `_ready()` 内同步报告失败，需提供该方法以便控制器读取已发生的失败状态。没有协议时以节点就绪与首帧绘制为准；只有 readiness 方法时控制器逐帧检查。加载控制器不引用毒岛类；毒岛装配脚本将 LevelReadiness 与 RenderWarmup 状态转发到通用协议。统一加载层显示时，原预热遮罩隐藏；F6 单独运行毒岛仍显示原遮罩。业务冻结继续由 LevelReadiness 管理。

微信加载界面在 Godot 加载页首帧后关闭，此时立即接受资源请求，不等待版本确认。下载最大并发 3，已挂载包复用；逐包解码一次、写入虚拟文件系统、通过 GDScript 挂载，并在阶段间让出绘制机会。单线程 Web 的一次解码、实例化或 Shader 编译仍可能阻塞动画；本次不引入 Worker、不修改引擎。未知工作量显示等待状态；预热数量是已提交绘制任务，不表示 GPU 编译完全完成。

## 缓存、更新与故障

磁盘只缓存 `.br`，解压 PCK 只保留于本次运行的虚拟文件系统。缓存按清单地址隔离，再按项目、引擎版本与包哈希区分。同次运行固定清单；只改 B 时 A/C 复用，需要 B 时才下载新版。

成功记录为 `{record_schema: 1, manifest, confirmed_scene}`，兼容读取旧版直接保存的清单。加载页显示、packs_ready、场景实例化均不提交成功版本；目标业务就绪后才提交，并删除新清单不再引用的旧缓存。新清单其他关卡的已有缓存保留。

启动前获取清单、下载或解码失败，可以整体回退旧版本，但必须校验加载页、上次确认关卡及全部依赖的压缩缓存和解压内容。仅有加载页缓存不算完整版本。加载页按 `rollback_scene()` 进入已确认关卡。首次运行没有成功记录时需要联网。

启动后禁止混挂旧包。资源失败保留 Godot 页面，可原地重试；预热失败使用业务 retry_preparation；挂载或引擎状态不确定时要求重启。示例“重启并使用上次成功版本”先校验旧缓存、写入一次性回退标记，再调用宿主 `wx.restartMiniProgram`；重启失败删除标记，下次启动消费标记并重新校验旧缓存。宿主不支持重启 API 时提示失败。目标成功前保留旧记录和旧包，成功后才清理。

缓存损坏时联网重新下载，离线且缓存不完整时明确报错。哈希只检查完整性，不能防止 HTTP 清单在传输途中被替换；公开发布建议使用 HTTPS。保留 `GODOTSDK.loadScene()` 与旧桥接 `load_scene()` 兼容入口；它们不会自动等待自定义预热协议，加载页应使用拆分接口。

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

加载页可用 `--confirmed-scene res://a/A.tscn` 验证；加 `--fail-gameplay-once` 在后台模拟一次下载失败并点击 Godot 重试按钮。测试记录首帧、包请求、预热与版本提交顺序，并保存加载/失败/完成截图。

scene-test 主页使用 `--home-ui --confirmed-scene res://levels/level_01/level_01.tscn` 验证三次真实触屏往返、主页不提前下载或提交版本，以及重复进入不重复挂载。`--home-cycles 1 --fail-gameplay-once` 检查失败后重试。`--home-preview-only --home-size 320x568`、`--home-size 844x390` 分别检查窄屏与横屏，`--home-preview-only --home-safe-area` 模拟安全区和胶囊。适配引擎固定初始画布尺寸，必须每个尺寸重新启动测试；这些截图不代表设备旋转已验收。

JS 回归验证依赖顺序、并发限制、压缩缓存、损坏重下载、版本提交失败、整版离线回退及禁止混版。模拟微信接口和无头 Godot 不能代替微信宿主与 Android/iOS 真机验收。

执行 `python tools/package_loading_delivery.py` 生成 `dist/scene-packer-runtime-4.0.0.zip` 与 `dist/godot-loading-example-4.0.0.zip`；输出文件已存在时拒绝覆盖，可用 `--output-dir` 指定新目录。插件 ZIP 单独由 package_plugin.py 生成。运行端 ZIP 覆盖微信工程的对应 engine 脚本，保留工程自身清单 URL、AppID 和现有 3D 引擎；例子 ZIP 是可编辑项目。

已执行的检查、产物标识及未测范围见[验证记录](scene-packs-validation.md)。
