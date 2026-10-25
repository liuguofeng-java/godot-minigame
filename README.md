# Godot 微信小游戏适配

一个源码工程：**拉取官方 Godot → 应用微信适配 → 编译 Web 引擎 → 组装小游戏**。
不再包含编辑器插件、DLL、`godot-cpp`、模板下载管理或预编译引擎。

Windows 操作步骤、重新编译和常见报错见 [使用指南](使用指南.md)。

## 目录与版本

| 目录 | 内容 |
| --- | --- |
| `build.py` | 统一命令入口：拉取、适配、编译、打包 |
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
    └── godot-sdk.js          # 可读 SDK
tools/
tests/
examples/minimal/
build/                       # 本地下载与编译
dist/                        # 最终输出
```

`wechat/` 的相对路径与输出工程一致，打包时整体复制，再向 `engine/` 分包补入生成的 `godot.js` 和 `godot.wasm.br`。不要把生成的引擎或游戏 PCK 放回维护源码目录。
`engine/sources/` 保留 Godot 的路径层级，方便直接定位覆盖目标。旧的 `runtime/` 和 `template/` 已合并为 `wechat/`，旧 `scripts/` 改为 `tools/`；构建命令统一使用根目录 `build.py`。

唯一版本源是 `engine/manifest.json`：Godot **4.7.2-stable**，提交
`ed1daf0bf001b61586d9930840f2f1394092c079`，Emscripten **4.0.11**。
默认关闭线程、SIMD 和 3D，启用体积优化和 LTO。`--enable-3d` 仅开启 3D。
只支持标准 WebGL2；不包含 WXGLX 或厂商静态库。

## 本地准备

安装 Git、Python 3.10+、SCons、Node.js、Brotli 命令行工具，以及清单指定版本的 Emscripten SDK。
网络需要代理时，由使用者设置 Git/终端代理；脚本不内置代理或镜像。

```text
python -m pip install scons
git clone --depth=1 https://github.com/emscripten-core/emsdk.git build/emsdk-4.7.2
```

Windows PowerShell：先保存系统 Python 路径，避免激活 SDK 后切换到其内置 Python。

```powershell
$python = (Get-Command python).Source
$version = (Get-Content engine/manifest.json -Raw | ConvertFrom-Json).emscripten_version
& .\build\emsdk-4.7.2\emsdk.bat install $version
& .\build\emsdk-4.7.2\emsdk.bat activate $version
# 将 emsdk 环境导入当前 PowerShell；不修改系统环境变量。
& .\build\emsdk-4.7.2\emsdk_env.ps1
```

也可以在 Windows 命令提示符中运行 `build\emsdk-4.7.2\emsdk_env.bat`，再使用已安装 SCons 的 Python 完整路径执行以下命令。
Windows 上可通过 MSYS2 安装 `mingw-w64-ucrt-x86_64-brotli`，并将 `C:\msys64\ucrt64\bin` 加入当前终端 PATH。Web 引擎由 Emscripten 编译，不再使用之前的 Windows 插件编译命令。

Linux Bash：

```bash
sudo apt-get install brotli
PYTHON=$(command -v python3)
VERSION=$($PYTHON -c 'import json; print(json.load(open("engine/manifest.json"))["emscripten_version"])')
build/emsdk-4.7.2/emsdk install "$VERSION"
build/emsdk-4.7.2/emsdk activate "$VERSION"
source build/emsdk-4.7.2/emsdk_env.sh
```

## 拉取与构建

下列 `python` 指已安装 SCons 的 Python；PowerShell 可使用 `& $python`，Linux 可使用 `"$PYTHON"`。

```text
python build.py fetch
python build.py apply
python build.py build --jobs 8
```

默认源码路径是 `build/godot-4.7.2`。所有子命令支持 `--source <路径>`。
默认目录由清单的 `source_dir` 指定。旧的 `build/godot` 和 `build/emsdk` 可保留，但当前流程不再使用它们；本地 SDK 使用 `build/emsdk-4.7.2`。
重复 `fetch` 不会重置现有源码；已有不同提交会报错。`apply` 先在临时目录验证全部补丁，成功后发布；重复应用会检查已应用文件，发现本地修改或补丁更新时要求使用新目录，不覆盖修改。

需要 3D 时使用：

```text
python build.py build --enable-3d --jobs 8
```

加 `--dry-run` 可查看构建配置；它不编译，也不能作为构建成功的证明。
升级引擎需要更新清单和补丁，重新验证，不能只替换版本号。
本次 4.7.2 迁移保留了官方 WebGL 离屏缓冲区和显式帧提交逻辑，并合入新版音频头文件及显示枚举变化。这里只支持清单中的固定提交。

## 组装并运行游戏

构建成功后，执行一个命令生成引擎模板：

```text
python build.py package
```

命令只组装引擎与运行时，不接收游戏资源包路径和 AppID 参数。生成后手动配置：

1. 使用匹配版本的 Godot 编辑器打开自己的项目或 `examples/minimal/project.godot`。
2. 使用 Compatibility 渲染器，通过 Web 预设的“导出 PCK/ZIP”导出资源包。示例已有 `Web PCK` 预设。
3. 将资源包复制到 `dist/wxgame/engine/demo-pck.bin`，文件名必须一致。
4. 在 `dist/wxgame/project.config.json` 中填写自己的**小游戏** AppID，也可在微信开发者工具导入时填写。
5. 用微信开发者工具导入 `dist/wxgame`，编译并在手机上预览。

生成时 `BUILD_STATUS.txt` 明确标为不完整模板：需要手动补充资源包和 AppID 才能预览。
已有输出目录不会被覆盖；再次打包请使用 `--output dist/wxgame-next` 或先自行保存并移走旧目录。

打包会复制并后处理构建的 `godot.js`，将同次构建的 WASM 进行 Brotli 压缩，然后复制运行时和模板配置。
`.pck` 只是改名为 `demo-pck.bin`，不是重新编译到 WASM。生成文件及其哈希、构建选项记录在 `build-info.json`。
构建后的原始 `godot.js` 不会被打包操作原地修改。WASM 和 JavaScript 必须配套，禁止混用官方 Web 引擎或旧 SDK。

## GitHub Actions

推送相关源码、提交 PR 或手动运行 **Build WeChat Godot engine**。
CI 使用相同脚本，拉取清单中的官方提交和 SDK，运行测试、构建并上传 `wechat-engine-template-2d`。
手动运行可勾选 `enable_3d` 验证完整 3D 构建。CI 产物不包含用户游戏 PCK 和私人 AppID，不是直接可玩的游戏。

## 音频与维护边界

- C++ 音频驱动和声明以补丁维护，编译进 WASM；`library_godot_audio.js` 合入生成的 `godot.js`。
- 短音频保留 WebAudio，满足原有条件的长音频使用微信原生播放；默认阈值 3 秒、缓存上限 8 MiB，可在模板音频配置中修改。
- 保留 manifest 读取能力，模板提供空 manifest；不再自动提取音频、注入资源元数据或生成音频分包。
- 不修改已有音频桥接 API；不承诺所有音频格式和设备表现一致，需真机验证。
- `wechat/` 与 `engine/sources/` 是可维护源码；`godot.js`、WASM、PCK 是构建产物。生成的 `godot.js` 仍可压缩优化。
- 第三方兼容层来源说明见 `wechat/NOTICE.md`。继承的 crypto 辅助实现不提供密码学安全随机数，不能用于密钥或令牌。

## 验证

```text
python tools/test.py
node tools/validate_runtime.js dist/wxgame
```

打包回归测试需要 Brotli；若未安装会显示跳过，不能视为完成打包验证。
自动测试使用模拟微信接口，覆盖标准 WebGL2、高 DPI、启动顺序、资源读取、音频上下文复用与缓存保护、存档字节和网络分块。
Python 测试覆盖拉取固定提交、补丁失败不发布、重复应用、源码保护、3D 参数及引擎模板打包。

`examples/minimal` 提供存档计数、短音、长音和停止按钮。人工验收：点击保存后立即读回，重启确认持久化；短音/长音播放、停止、重播；切到后台再返回；检查加载画面与按钮输入。
需在微信开发者工具及 Android/iOS 真机分别验证。桌面测试和编译通过不能替代这些检查。

MIT；保留第三方及官方 Godot 各自的许可证声明。
