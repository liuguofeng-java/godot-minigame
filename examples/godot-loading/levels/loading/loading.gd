## 跨场景的加载流程控制器；界面通过信号显示状态，业务场景通过就绪协议接入。
extends Node

signal activity_changed(active: bool)
signal progress_changed(label: String, completed: float, total: float, detail: String)
signal error_occurred(message: String, retryable: bool, can_rollback: bool)
signal actions_reset
signal rollback_check_started
@onready var view: CanvasLayer = $View
var _serial := 0
var _active := true
var _relocating := false
var _bridge: Node
var _target := ""
var _request := -1
var _busy := false
var _retry_stage := "resources"
var _preparing_scene: Node


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	view.connect("retry_requested", _retry)
	view.connect("rollback_requested", _rollback)
	activity_changed.connect(view.set_active)
	progress_changed.connect(view.show_progress)
	error_occurred.connect(view.show_error)
	actions_reset.connect(view.reset_actions)
	rollback_check_started.connect(view.show_rollback_check)
	_start.call_deferred()


## 组是轻量协议入口，预热组件无需引用加载页脚本或共享根节点元数据。
func is_loading() -> bool:
	return _active


func _set_active(active: bool) -> void:
	_active = active
	activity_changed.emit(active)


## 脱离启动场景后再发请求，避免切场景释放控制器；首帧绘制后才下载玩法包。
func _start() -> void:
	# 再次进入启动场景时复用已有控制器，避免重复挂载桥接回调和加载遮罩。
	var existing := get_tree().get_first_node_in_group("scene_loading_controller")
	if existing != null and existing != self:
		existing.request_scene(str(ProjectSettings.get_setting("scene_packer/initial_scene", "")))
		queue_free()
		return
	add_to_group("scene_loading_controller")
	_relocating = true
	reparent(get_tree().root)
	_relocating = false
	name = "SceneLoading"
	_bridge = get_node_or_null("/root/__ScenePackReady")
	if _bridge != null:
		_bridge.progress.connect(_progress)
		_bridge.packs_ready.connect(_packs_ready)
		_bridge.failed.connect(_failed)
		_bridge.scene_confirmed.connect(_confirmed)
		_bridge.confirmation_failed.connect(_confirmation_failed)
		_bridge.rollback_failed.connect(_rollback_failed)
	# Render the page before asking for any gameplay packages.
	await _drawn()
	var target := str(ProjectSettings.get_setting("scene_packer/initial_scene", ""))
	if _bridge != null and not str(_bridge.rollback_scene()).is_empty():
		target = str(_bridge.rollback_scene())
	request_scene(target)


## 唯一的进入场景入口；断开旧关卡信号并保存请求 ID，隔离过期回调。
func request_scene(path: String) -> void:
	if _busy:
		return
	if is_instance_valid(_preparing_scene):
		if (
			_preparing_scene.has_signal("preparation_progress")
			and _preparing_scene.is_connected("preparation_progress", _preparation_progress)
		):
			_preparing_scene.disconnect("preparation_progress", _preparation_progress)
		if (
			_preparing_scene.has_signal("preparation_finished")
			and _preparing_scene.is_connected("preparation_finished", _preparation_finished)
		):
			_preparing_scene.disconnect("preparation_finished", _preparation_finished)
	_preparing_scene = null
	_serial += 1
	_target = path
	_set_active(true)
	if _target.is_empty():
		_error("尚未配置要进入的场景。", false)
		return
	_busy = true
	_retry_stage = "resources"
	actions_reset.emit()
	_show_progress("正在准备", 0, 0)
	if _bridge != null:
		_request = int(_bridge.prepare_scene(_target))
	else:
		_request += 1
		_load_resource.call_deferred()


## 下载计量为压缩字节，其余远程阶段为包数；未知总量保持等待状态。
func _progress(id: int, stage: String, completed: float, total: float, _pack: String) -> void:
	if id != _request or not _busy:
		return
	var labels := {"download": "正在下载资源", "verify": "正在检查资源", "decode": "正在解压资源", "mount": "正在准备场景"}
	var detail := ""
	if stage == "download" and total > 0:
		detail = (
			"%s / %s" % [String.humanize_size(int(completed)), String.humanize_size(int(total))]
		)
	elif total > 0:
		detail = "%s / %s" % [int(completed), int(total)]
	_show_progress(str(labels.get(stage, "正在准备")), completed, total, detail)


func _packs_ready(id: int, path: String) -> void:
	if id == _request and path == _target and _busy:
		_load_resource()


## 包已挂载后异步读取 PackedScene；持续保留遮罩直到新场景和可选预热协议完成。
func _load_resource() -> void:
	var ticket := _serial
	_show_progress("正在加载场景", 0, 0)
	await _drawn()
	if not _current(ticket):
		return
	var error := ResourceLoader.load_threaded_request(_target, "PackedScene", false)
	if error != OK:
		_error("场景资源加载失败，请重试。", true)
		return
	while _current(ticket):
		var values: Array = []
		var state := ResourceLoader.load_threaded_get_status(_target, values)
		if state == ResourceLoader.THREAD_LOAD_LOADED:
			break
		if state != ResourceLoader.THREAD_LOAD_IN_PROGRESS:
			_error("场景资源加载失败，请重试。", true)
			return
		_show_progress(
			"正在加载场景",
			float(values[0]) if not values.is_empty() else 0.0,
			1.0 if not values.is_empty() else 0.0
		)
		await get_tree().process_frame
	if not _current(ticket):
		return
	var scene := ResourceLoader.load_threaded_get(_target) as PackedScene
	if scene == null:
		_error("场景资源无效，请重启后重试。", false)
		return
	_show_progress("正在进入场景", 0, 0)
	await _drawn()
	if not _current(ticket):
		return
	if get_tree().change_scene_to_packed(scene) != OK:
		_error("无法进入场景，请重启后重试。", false)
		return
	await get_tree().scene_changed
	if not _current(ticket):
		return
	var current := get_tree().current_scene
	if current == null or current.scene_file_path != _target:
		_error("场景发生变化，请重启后重试。", false)
		return
	if current.has_method("is_ready_for_play"):
		_preparing_scene = current
		if current.has_signal("preparation_progress"):
			current.connect("preparation_progress", _preparation_progress)
		if current.has_signal("preparation_finished"):
			current.connect("preparation_finished", _preparation_finished)
		if bool(current.call("is_ready_for_play")):
			_preparation_finished(true, "")
		elif (
			current.has_method("get_preparation_error")
			and not str(current.call("get_preparation_error")).is_empty()
		):
			_preparation_finished(false, str(current.call("get_preparation_error")))
		else:
			_show_progress("正在准备画面", 0, 0)
			if not current.has_signal("preparation_finished"):
				while (
					_current(ticket)
					and is_instance_valid(current)
					and not bool(current.call("is_ready_for_play"))
				):
					await get_tree().process_frame
				if _current(ticket) and is_instance_valid(current):
					_preparation_finished(true, "")
	else:
		await _drawn()
		if not _current(ticket):
			return
		_preparation_finished(true, "")


func _preparation_progress(completed: int, total: int) -> void:
	if _busy:
		_show_progress(
			"正在准备画面", completed, total, "%s / %s" % [completed, total] if total > 0 else ""
		)


## 业务完成后才确认版本，保存失败时保持遮罩和旧版缓存以便重试。
func _preparation_finished(ok: bool, message: String) -> void:
	if not _busy:
		return
	if not ok:
		_retry_stage = "preparation"
		_error(message, true)
		return
	_retry_stage = "confirmation"
	_show_progress("准备完成", 1, 1)
	if _bridge != null:
		_bridge.confirm_scene_ready(_target)
	else:
		var ticket := _serial
		await _drawn()
		if _current(ticket):
			_confirmed(_target)


## 收到成功提交回执后解除统一遮罩；原关卡预热层恢复独立显示的权限。
func _confirmed(scene: String) -> void:
	if scene != _target or not _busy:
		return
	_busy = false
	_set_active(false)
	print("GODOT_LOADING_COMPLETE ", scene)


func _failed(id: int, _code: String, message: String, retryable: bool) -> void:
	if id == _request and _busy:
		push_warning(message)
		var pack := message.get_slice(":", 0)
		var label := (
			"资源包 %s" % pack
			if RegEx.create_from_string("^[a-z][a-z0-9_-]{0,47}$").search(pack) != null
			else "资源"
		)
		_error(label + ("准备失败，请检查网络后重试。" if retryable else "挂载失败，请重启后重试。"), retryable)


func _confirmation_failed(scene: String, message: String) -> void:
	if scene != _target or not _busy:
		return
	push_warning(message)
	_retry_stage = "confirmation"
	_error("无法保存本次加载状态，请重试。", true)


func _error(message: String, retryable: bool) -> void:
	_busy = false
	error_occurred.emit(message, retryable, _bridge != null and bool(_bridge.can_rollback()))


## 根据失败阶段重试，已实例化关卡的预热重试不重新下载或重建场景。
func _retry() -> void:
	if _busy:
		return
	actions_reset.emit()
	var current := get_tree().current_scene
	if (
		_retry_stage == "preparation"
		and current != null
		and current.has_method("retry_preparation")
	):
		_busy = true
		_show_progress("正在准备画面", 0, 0)
		if current.has_method("is_ready_for_play") and bool(current.call("is_ready_for_play")):
			_preparation_finished(true, "")
		else:
			current.call("retry_preparation")
	elif _retry_stage == "confirmation":
		_busy = true
		_preparation_finished(true, "")
	else:
		request_scene(_target)


## 回退必须交给宿主重启，禁止在当前引擎中混挂不同版本的包。
func _rollback() -> void:
	if _bridge != null:
		rollback_check_started.emit()
		_bridge.restart_previous()


func _rollback_failed(message: String) -> void:
	push_warning(message)
	_error("上次成功的资源不完整，无法回退。", true)


func _show_progress(text: String, completed: float, total: float, detail: String = "") -> void:
	progress_changed.emit(text, completed, total, detail)


## 代次用于拒绝旧请求在让出绘制之后继续切换场景。
func _current(ticket: int) -> bool:
	return ticket == _serial and _busy and is_inside_tree() and not is_queued_for_deletion()


func _drawn() -> void:
	if DisplayServer.get_name() == "headless":
		await get_tree().process_frame
	else:
		await RenderingServer.frame_post_draw


func _exit_tree() -> void:
	if _relocating:
		return
	_serial += 1
	if _active:
		_set_active(false)
