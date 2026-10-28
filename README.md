# Godot 微信小游戏适配

一个源码工程：**拉取官方 Godot → 应用微信适配 → 编译 Web 引擎 → 组装小游戏**。
包含可独立安装的场景分包插件；不包含 DLL、`godot-cpp`、模板下载管理或预编译引擎。

仓库根目录不是可直接运行的 Godot 游戏；它用于构建微信小游戏引擎模板。游戏内容需要从 Godot 项目另行导出为 PCK。

## 目录与版本

| 目录 | 内容 |
| --- | --- |
| `build.py` | 统一命令入口：拉取、适配、编译引擎、打包 PCK 和微信工程 |
| `engine/` | Godot 引擎适配：版本清单、C++ 补丁、编译进引擎的 JS |
| `wechat/` | 微信工程模板：可读 SDK、加载器、浏览器接口、入口和配置 |
| `tools/` | 命令实现、JS 后处理、校验和测试入口 |
| `tests/` | 加载、音频、存档、网络、源码准备和打包测试 |
| `examples/minimal/` | 不依赖插件的 Godot 冒烟测试场景 |
| `build/` | 下载的 Godot、工具链和编译缓存，Git 忽略 |
| `dist/` | 组装后的微信工程，Git 忽略 |

```text
build.py
engine/
├── manifest.json
├── patches/                  # 修改官方 C++ 和构建流程的补丁
└── sources/platform/web/     # 按 Godot 原路径覆盖的 JS 源码
wechat/
├── game.js                  # 微信主入口
├── game.json
├── project.config.json
├── godot-loader.js
├── weapp-adapter.js
├── native-audio-config.js
├── native-audio-manifest.js
├── NOTICE.md
├── images/
└── engine/
    ├── game.js              # 引擎分包入口
    ├── godot-sdk.js          # 可读 SDK
    ├── pack-config.js        # 本地或远程 PCK 配置
    ├── remote-pack.js        # 下载、校验和缓存
    └── vendor/               # Brotli 解码器及许可证
tools/
tests/
examples/minimal/
build/                       # 本地下载与编译
dist/                        # 最终输出
```

## 运行项目（Windows Git Bash）

### 1. 准备工具

安装 Git、Python 3.10+、Node.js、Brotli 命令行工具、Godot **4.7.2** 编辑器（含 Web 导出模板）和微信开发者工具。构建引擎还需要 SCons 与 Emscripten **4.0.11**。以下命令都在仓库根目录的 **Git Bash** 中执行；如果已在根目录，不必再运行 `cd`。

```bash
cd /d/project/godot-minigame  # 按实际仓库位置修改
BUILD_PYTHON="$(command -v python)"
"$BUILD_PYTHON" -m pip install scons
```

首次使用时，克隆并安装固定版本的 Emscripten。`build/emsdk-4.7.2` 已存在时跳过 `git clone`；SDK 已安装时 `install` 会跳过已完成的部分。

```bash
git clone --depth=1 https://github.com/emscripten-core/emsdk.git build/emsdk-4.7.2
"$BUILD_PYTHON" build/emsdk-4.7.2/emsdk.py install 4.0.11
"$BUILD_PYTHON" build/emsdk-4.7.2/emsdk.py activate 4.0.11
export EMSDK_PYTHON="$BUILD_PYTHON"
source build/emsdk-4.7.2/emsdk_env.sh
emcc --version
brotli --version
```

`export EMSDK_PYTHON` 要放在 `source` 之前：某些 Windows 环境中的 `python3` 只是 Microsoft Store 的空别名，会导致 `emsdk_env.sh` 失败。若缺少 Brotli，可在 Windows 终端运行 `winget install --id Google.Brotli --exact`，重新打开 Git Bash 后用 `brotli --version` 确认。

### 2. 构建并打包微信工程

确认 `emcc --version` 显示 4.0.11，然后按顺序执行；上一条成功后再运行下一条。

```bash
"$BUILD_PYTHON" build.py fetch
"$BUILD_PYTHON" build.py apply
"$BUILD_PYTHON" build.py build --jobs 8
"$BUILD_PYTHON" build.py package
```

默认构建 2D、无线程的 WebGL2 引擎。需要 3D 时，将构建命令改为 `"$BUILD_PYTHON" build.py build --enable-3d --jobs 8`。首次编译可能需要较长时间；`package` 只能在 `build` 成功后运行，生成的模板在 `dist/wxgame/`。重复 `fetch` 和 `apply` 会验证已有源码，不必因打开新终端而重跑。

`package` 不覆盖已有目录。若 `dist/wxgame/` 已存在，使用 `"$BUILD_PYTHON" build.py package --output dist/wxgame-next`，并在后续步骤中使用新的输出目录。

### 3. 导出游戏并在微信中运行（本地 PCK）

1. 用 Godot **4.7.2** 打开自己的 Godot 项目，或打开 `examples/minimal/project.godot` 试跑示例。示例可先在编辑器中按 **F5** 运行；根目录不是 Godot 项目。
2. 项目使用 **Compatibility** 渲染器。在 Godot 的“项目 → 导出”中选择 Web 预设，使用“导出 PCK/ZIP”生成 `.pck`。最小示例已配置 `Web PCK` 预设。
3. 将 `.pck` 复制到输出工程的 `engine/` 目录，命名为 `demo-pck.bin`，例如 `dist/wxgame/engine/demo-pck.bin`。这里只是改名，不是重新压缩。
4. 在输出工程的 `project.config.json` 填写自己的**微信小游戏 AppID**，也可在微信开发者工具导入时填写。
5. 在微信开发者工具中以“小游戏”类型导入**整个** `dist/wxgame/`，点击编译并用手机预览。不要只导入 `engine/` 子目录。

`package` 只生成引擎模板，不包含游戏 PCK 和 AppID；缺少任一项时不能作为完整小游戏预览。最小示例可用于检查按钮、存档计数、短音频、长音频和停止播放，存档应在重启后再次确认。

### 4. 远程加载 Brotli PCK

先按第 3 步从 **Godot 4.7.2** 导出 `.pck`，再运行以下命令。`--base-url` 是将来放置 `.pck.br` 文件的 HTTPS 目录地址，不是小程序代码包路径。

```bash
"$BUILD_PYTHON" build.py pack-pck \
  --pck path/to/game.pck \
  --base-url https://cdn.example.com/godot/ \
  --output dist/packs
```

命令会打印两个输出路径：带内容哈希的 `.pck.br` 文件和配套 `.json` 配置。将 `.pck.br` 上传到配置中的 `url`，保持文件名不变。服务器应直接返回压缩文件字节（建议 `Content-Type: application/octet-stream`），**不要设置 `Content-Encoding: br`**，否则客户端可能收到已自动解压的数据。把该 HTTPS 域名加入微信小游戏后台的**下载合法域名**。

用命令打印出的配置文件路径组装新的微信工程：

```bash
"$BUILD_PYTHON" build.py package \
  --remote-pack-config "dist/packs/生成的配置文件.json" \
  --output dist/wxgame-remote
```

在 `dist/wxgame-remote/project.config.json` 填入自己的小游戏 AppID，再用微信开发者工具以**小游戏**类型导入整个目录。远程模式无需把 `.pck` 或 `.br` 复制进 `engine/` 分包。首次启动需要联网下载；成功启动后缓存压缩文件，后续启动命中当前版本缓存时直接加载。新版本下载或启动失败时会尝试上次成功版本；没有可用缓存时会显示加载错误。

每次发布新游戏内容都重新运行 `pack-pck`，上传新文件，并用新生成的配置重新 `package`、发布小游戏版本。文件名包含内容哈希，请勿覆盖旧文件。原来的本地 `demo-pck.bin` 方式仍可按第 3 步使用。

### 5. 将 Brotli PCK 放进小游戏分包

如果压缩后的 `.pck.br` 与引擎合计符合微信小游戏包体限制，也可以直接随工程发布，不需要 CDN。先按上一步生成 `.pck.br` 和 JSON 配置；此模式会读取 JSON 旁边的压缩文件，配置里的 URL 仅用于定位对应文件，不会在运行时请求。

```bash
"$BUILD_PYTHON" build.py package \
  --bundled-pack-config "dist/packs/生成的配置文件.json" \
  --output dist/wxgame-bundled
```

命令将压缩文件复制为输出工程的 `engine/demo-pck.br`，启动时校验 SHA-256、解压并交给 Godot。填写 `project.config.json` 的 AppID 后，以小游戏类型导入整个输出目录。与远程模式一样，实际包体大小和真机内存占用仍要在微信开发者工具及设备上验证。

### 6. 从 scene-test 导出场景依赖分包

通用“场景分包”插件通过文件树把多个目录或文件分配到同一个包，检查全项目所有场景的递归依赖，导出 `manifest.json` 和 `.pck.br`。插件不上传资源或组装微信工程。生成安装包：`python tools/package_plugin.py`。安装、缓存更新和后台验证见[场景分包与远程加载](docs/scene-packs.md)。`scene-test` 已接入独立 Godot 加载页，首屏仅下载轻量启动资源，玩法包由 GDScript 按需准备。schema-4、就绪确认及回退接口见同一文档。

新流程按远程清单启动，持久缓存只保存压缩包；修改 B 后只下载新版 B，成功进入场景后清理旧缓存。需重新编译包含 `--extra-pack` 补丁的引擎，3D 项目必须使用 `--enable-3d`。组装示例：

```bash
python build.py package --manifest-url https://cdn.example.com/game/manifest.json --output dist/wxgame-manifest
```

清单地址也可使用固定的 HTTP `.json` URL，例如局域网调试时使用 `--manifest-url http://10.198.46.142:9000/manifest.json`，无需额外参数。发布时仍需确认微信平台接受该地址及其域名配置。`--local-manifest-dev` 仅用于调试时允许加载同一主次版本的较早补丁版本资源包。

已有固定 schema-1 清单仍可使用原组装接口：

```bash
python build.py package \
  --bundled-pack-config path/to/base/bootstrap.json \
  --scene-pack-manifest path/to/manifest.json \
  --output dist/wxgame-scene-packs
```

本地组自动写入 `game.json` 的微信分包；远程组的 `.br` 文件由开发者按清单 URL 上传。当前版本的远程压缩包命中缓存时直接加载；失败时保留可重试界面，不使用旧版本包。单 PCK 的本地、远程及随包模式仍可使用。

### 再次打开 Git Bash

新终端需要重新加载 Emscripten 环境，已完成的 SDK 安装、源码拉取和适配无需重做：

```bash
BUILD_PYTHON="$(command -v python)"
export EMSDK_PYTHON="$BUILD_PYTHON"
source build/emsdk-4.7.2/emsdk_env.sh
```

常见错误：`Missing SCons` 表示当前构建使用的 Python 未安装 SCons；`Missing emcc` 表示 SDK 环境没有成功加载；`Missing successful build metadata` 表示 `build` 尚未成功；`Output already exists` 表示需要换一个 `--output` 目录。命令入口是 `"$BUILD_PYTHON" build.py ...`，不能直接执行 `build.py ...`。

## 源码格式与清理

维护脚本采用 UTF-8、LF 和 100 列目标宽度；GDScript 用 Tab，Python/JS 用 4 空格。安装 `requirements-dev.txt` 后执行 `python tools/format_sources.py` 检查，加 `--write` 才修改。JS 默认通过 npx 使用 Prettier 3.6.2；已有 CLI 可用 `--prettier <prettier.cjs 路径>` 指定。脚本跳过引擎源码覆盖、补丁、第三方库、缓存和发布产物。

资源及方法删除需检查动态调用、编辑器回调、信号和公开兼容接口。微信图片由加载器配置使用；即使远程加载页启用，旧模式的图像与桥接接口仍需保留。插件以 `addons/scene_packer` 为规范源，并同步 scene-test 安装副本；示例加载控制器与 scene-test 保持一致。

注释优先说明生命周期、状态约束、数据单位与必要副作用。运行 `python tools/test.py` 和后台 Godot 导出/面板验证确认整理未破坏行为；格式化不要求重新编译引擎。

本次清理范围、保留项、验证及安装包标识见[源码整理与验证](docs/source-maintenance.md)。
