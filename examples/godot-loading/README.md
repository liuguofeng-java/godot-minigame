# Godot 加载页示例

将插件 `addons/scene_packer/` 安装到本目录。按 F5 可直接运行，普通本地运行跳过远程分包。分包导出后，微信加载器先启动 loading，再由它准备 demo。实际毒岛集成位于相邻 scene-test 工程。

修改 `project.godot` 的 `scene_packer/initial_scene` 指定关卡，在 `scene_packs.json` 中分配相应包；保留 `startup_mode="godot_loading"` 与加载场景作为工程启动项。不要在 loading 脚本中 preload 玩法资源。`loading.tscn` 装配控制器和界面，修改画面请编辑独立的 `levels/loading/loading_view.tscn` 与 `loading_view.gd`；流程在 `loading.gd` 中维护，两者通过信号连接。

控制器 `/root/SceneLoading` 持续存在，后续调用 `request_scene(path)`。重复进入启动场景会复用同一控制器；预热遮罩可通过 `scene_loading_controller` 组及 `is_loading()`、`activity_changed(active)` 协议协调。通用桥接接口、可选准备协议、升级和回退见 [场景分包文档](../../docs/scene-packs.md#godot-加载页模式)。字体遵循 [OFL](assets/fonts/OFL.txt)。

控制器也支持主页驱动：`auto_start=false` 时只初始化桥接；等待 `initialized` 或 `initialization_completed` 后，由开始按钮调用 `request_initial_scene()`。该方法兼容回退版本的已确认目标。设置 `home_scene` 后可调用 `return_home()`，它重建主页、复用控制器和已挂载资源，不把主页确认为成功关卡。当前示例保留默认 `auto_start=true`，业务主页与 PNG 美术在 scene-test 中维护。

自定义加载视图可实现异步 `cover_scene()` 与 `reveal_scene()`：控制器等待前者完整覆盖旧画面后开始资源准备，目标就绪并确认成功后等待后者揭幕。过渡时继续保持加载状态并短暂暂停游戏，完成或退出后恢复原暂停状态；不实现这些方法时保留原行为。不要在视图中另行切换场景或提交成功版本。
