# Godot 加载页示例

将插件 `addons/scene_packer/` 安装到本目录。按 F5 可直接运行，普通本地运行跳过远程分包。分包导出后，微信加载器先启动 loading，再由它准备 demo。实际毒岛集成位于相邻 scene-test 工程。

修改 `project.godot` 的 `scene_packer/initial_scene` 指定关卡，在 `scene_packs.json` 中分配相应包；保留 `startup_mode="godot_loading"` 与加载场景作为工程启动项。不要在 loading 脚本中 preload 玩法资源。`loading.tscn` 装配控制器和界面，修改画面请编辑独立的 `levels/loading/loading_view.tscn` 与 `loading_view.gd`；流程在 `loading.gd` 中维护，两者通过信号连接。

控制器 `/root/SceneLoading` 持续存在，后续调用 `request_scene(path)`。重复进入启动场景会复用同一控制器；预热遮罩可通过 `scene_loading_controller` 组及 `is_loading()`、`activity_changed(active)` 协议协调。通用桥接接口、可选准备协议、升级和回退见 [场景分包文档](../../docs/scene-packs.md#godot-加载页模式)。字体遵循 [OFL](assets/fonts/OFL.txt)。
