## 仅注入导出副本的传输桥；保留公开方法供业务脚本和旧宿主按名称调用。
extends Node
signal scene_loaded(scene: String)
signal scene_load_failed(scene: String, message: String)
signal progress(request_id: int, stage: String, completed: float, total: float, pack_id: String)
signal packs_ready(request_id: int, scene: String)
signal failed(request_id: int, code: String, message: String, retryable: bool)
signal scene_confirmed(scene: String)
signal confirmation_failed(scene: String, message: String)
signal rollback_failed(message: String)

var _runtime: JavaScriptObject
var _callback: JavaScriptObject
var _mounted: Dictionary = {}
var _requests: Dictionary = {}
var _serial := 0


func _ready() -> void:
	if not OS.has_feature("web"):
		return
	var global: JavaScriptObject = JavaScriptBridge.get_interface("GameGlobal")
	if global == null or global.manifestPacks == null:
		return
	_runtime = global.manifestPacks
	_callback = JavaScriptBridge.create_callback(_command)
	_runtime.registerSceneLoader(_callback, 2)
	while get_tree().current_scene == null or not get_tree().current_scene.is_node_ready():
		await get_tree().process_frame
	await _drawn()
	_runtime.sceneReady(get_tree().current_scene.scene_file_path)


func _drawn() -> void:
	if DisplayServer.get_name() == "headless":
		await get_tree().process_frame
	else:
		await RenderingServer.frame_post_draw


## 合并同场景在途请求并立即返回 ID；只准备和挂载包，不实例化或切换场景。
func prepare_scene(scene: String) -> int:
	if _requests.has(scene):
		return int(_requests[scene])
	_serial += 1
	var id := _serial
	_requests[scene] = id
	_prepare.call_deferred(scene, id)
	return id


func _prepare(scene: String, id: int) -> void:
	if _runtime != null:
		_runtime.requestPrepare(scene, id)
	else:
		_requests.erase(scene)
		if ResourceLoader.exists(scene):
			packs_ready.emit(id, scene)
		else:
			failed.emit(id, "resource_missing", "场景不存在：" + scene, false)


## 验证当前场景及可选业务就绪状态；首帧后再次核验，再请求提交成功版本。
func confirm_scene_ready(scene: String) -> void:
	var current := get_tree().current_scene
	if current == null or current.scene_file_path != scene or not current.is_node_ready():
		confirmation_failed.emit(scene, "实际场景尚未准备完成。")
		return
	if current.has_method("is_ready_for_play") and not bool(current.call("is_ready_for_play")):
		confirmation_failed.emit(scene, "关卡仍在准备中。")
		return
	_confirm.call_deferred(scene)


func _confirm(scene: String) -> void:
	await _drawn()
	var current := get_tree().current_scene
	if (
		current == null
		or current.scene_file_path != scene
		or (current.has_method("is_ready_for_play") and not bool(current.call("is_ready_for_play")))
	):
		confirmation_failed.emit(scene, "场景或就绪状态已经变化，请重试。")
		return
	if _runtime != null:
		_runtime.requestConfirm(scene)
	else:
		scene_confirmed.emit(scene)


## 这里只判断是否存在候选版本；真正重启前由宿主校验其完整缓存。
func can_rollback() -> bool:
	return _runtime != null and bool(_runtime.canRollback())


## 返回整体回退时上次确认过的关卡；正常启动返回空字符串。
func rollback_scene() -> String:
	return str(_runtime.rollbackScene()) if _runtime != null else ""


## 请求宿主校验旧版并重启；失败通过 rollback_failed 信号返回。
func restart_previous() -> void:
	if _runtime != null:
		_runtime.requestRollback()
	else:
		rollback_failed.emit("本地运行没有远程版本可回退。")


## 兼容旧版的准备并切场景入口，供外部项目调用；新加载页使用拆分接口。
func load_scene(scene: String) -> void:
	if _runtime != null:
		_runtime.requestScene(scene)
	else:
		_load_scene.call_deferred({"id": 0, "scene": scene, "packs": [], "command": "load"})


## JS 回调只解析并排队，避免在 JavaScriptBridge 回调栈内重入场景树。
func _command(arguments: Array) -> void:
	var request: Variant = JSON.parse_string(str(arguments[0]))
	if request is Dictionary:
		_dispatch.call_deferred(request)


func _dispatch(request: Dictionary) -> void:
	match str(request.get("event", "")):
		"progress":
			progress.emit(
				int(request.request_id),
				str(request.stage),
				float(request.completed),
				float(request.total),
				str(request.pack)
			)
		"packs_ready":
			_requests.erase(str(request.scene))
			packs_ready.emit(int(request.request_id), str(request.scene))
		"failed":
			for scene: String in _requests.keys():
				if int(_requests[scene]) == int(request.request_id):
					_requests.erase(scene)
			failed.emit(
				int(request.request_id),
				str(request.code),
				str(request.error),
				bool(request.retryable)
			)
		"confirmed":
			scene_confirmed.emit(str(request.scene))
		"confirm_failed":
			confirmation_failed.emit(str(request.scene), str(request.error))
		"rollback_failed":
			rollback_failed.emit(str(request.error))
		"loaded":
			scene_loaded.emit(str(request.scene))
		"error":
			scene_load_failed.emit(str(request.scene), str(request.error))
		_:
			_load_scene(request)


## 按原 res:// 路径挂载；prepare 命令到此结束，load 命令才执行场景切换。
func _load_scene(request: Dictionary) -> void:
	for path: String in request.packs:
		if _mounted.has(path):
			continue
		if not ProjectSettings.load_resource_pack(path, false):
			_finish(request, "无法挂载资源包：" + path)
			return
		_mounted[path] = true
	if request.get("command", "load") == "prepare":
		_finish(request, "")
		return
	var error := get_tree().change_scene_to_file(str(request.scene))
	if error != OK:
		_finish(request, "无法加载场景：%s（%s），请重启后重试。" % [request.scene, error])
		return
	await get_tree().scene_changed
	if (
		get_tree().current_scene == null
		or get_tree().current_scene.scene_file_path != str(request.scene)
	):
		_finish(request, "实际运行场景与请求不一致，请重启后重试。")
		return
	await _drawn()
	_finish(request, "")


func _finish(request: Dictionary, error: String) -> void:
	if _runtime != null:
		_runtime.sceneLoaded(int(request.id), str(request.scene), error)
	elif error.is_empty():
		scene_loaded.emit(str(request.scene))
	else:
		scene_load_failed.emit(str(request.scene), error)
