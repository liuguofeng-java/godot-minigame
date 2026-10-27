extends Node
## Export-only bridge. Project startup settings and Autoload order are preserved.
signal scene_loaded(scene: String)
signal scene_load_failed(scene: String, message: String)

var _runtime: JavaScriptObject
var _callback: JavaScriptObject
var _mounted: Dictionary = {}

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	var global: JavaScriptObject = JavaScriptBridge.get_interface("GameGlobal")
	if global == null or global.manifestPacks == null:
		return
	_runtime = global.manifestPacks
	_callback = JavaScriptBridge.create_callback(_command)
	_runtime.registerSceneLoader(_callback)
	while get_tree().current_scene == null or not get_tree().current_scene.is_node_ready():
		await get_tree().process_frame
	_runtime.sceneReady(get_tree().current_scene.scene_file_path)

func load_scene(scene: String) -> void:
	if _runtime != null:
		_runtime.requestScene(scene)
	else:
		_load_scene.call_deferred({"id": 0, "scene": scene, "packs": []})

func _command(arguments: Array) -> void:
	var request: Variant = JSON.parse_string(str(arguments[0]))
	if not request is Dictionary:
		return
	if request.get("event") == "loaded":
		scene_loaded.emit(str(request.scene))
	elif request.get("event") == "error":
		scene_load_failed.emit(str(request.scene), str(request.error))
	else:
		# Leave JavaScript callback dispatch before mounting and changing the scene tree.
		_load_scene.call_deferred(request)

func _load_scene(request: Dictionary) -> void:
	for path: String in request.packs:
		if _mounted.has(path):
			continue
		if not ProjectSettings.load_resource_pack(path, false):
			_finish(request, "无法挂载资源包：" + path)
			return
		_mounted[path] = true
	var error := get_tree().change_scene_to_file(str(request.scene))
	if error != OK:
		_finish(request, "无法加载场景：%s（%s），请重启后重试。" % [request.scene, error])
		return
	await get_tree().scene_changed
	if get_tree().current_scene == null or get_tree().current_scene.scene_file_path != str(request.scene):
		_finish(request, "实际运行场景与请求不一致，请重启后重试。")
		return
	_finish(request, "")

func _finish(request: Dictionary, error: String) -> void:
	if _runtime != null:
		_runtime.sceneLoaded(int(request.id), str(request.scene), error)
	elif error.is_empty():
		scene_loaded.emit(str(request.scene))
	else:
		scene_load_failed.emit(str(request.scene), error)
