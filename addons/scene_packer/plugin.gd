@tool
extends EditorPlugin

const ANALYZER = preload("res://addons/scene_packer/analyzer.gd")
const PANEL = preload("res://addons/scene_packer/packer_panel.gd")
const CONFIG_SYNC = preload("res://addons/scene_packer/config_sync.gd")
const SELECTION = preload("res://addons/scene_packer/selection_rules.gd")
const CONFIG := "res://scene_packs.json"
var panel: PANEL
var tree: Tree
var packs: ItemList
var project_id: LineEdit
var pack_name: LineEdit
var depends: LineEdit
var destination: LineEdit
var brotli: LineEdit
var status: TextEdit
var export_button: Button
var config: Dictionary = {}
var current: String = ""
var rebuilding := false
var pid := -1
var result_path := ""
var log_path := ""
## 后台日志的已读取字节位置，避免轮询时反复解析整个文件。
var log_offset := 0
var poll: Timer
var config_watch: Timer
## 连续资源勾选合并为一次依赖分析，避免每次点击阻塞编辑器。
var analysis_timer: Timer
## 复用未变化资源的依赖扫描结果。
var live_analyzer: ANALYZER
var disk_hash := ""
var baseline: Dictionary = {}
var syncing := false
var closing := false
var analysis_queued := false
var tree_query := ""
## 当前筛选结果中的树节点，用于勾选后原位更新而不重建整棵树。
var tree_items: Dictionary = {}
## 当前树节点中代表文件的路径。
var tree_file_paths: Dictionary = {}
## 最近一次树构建所依据的完整文件列表。
var tree_files: Array[String] = []


func _enter_tree() -> void:
	var saved: Variant = (
		JSON.parse_string(FileAccess.get_file_as_string(CONFIG))
		if FileAccess.file_exists(CONFIG)
		else null
	)
	config = (
		saved
		if saved is Dictionary
		else {
			"schema": 1,
			"project_id": ProjectSettings.get_setting("application/config/name", "game"),
			"packs": {}
		}
	)
	disk_hash = FileAccess.get_sha256(CONFIG) if FileAccess.file_exists(CONFIG) else ""
	baseline = config.duplicate(true)
	panel = PANEL.new(EditorInterface.get_editor_scale())
	project_id = panel.project_id
	pack_name = panel.pack_name
	packs = panel.packs
	tree = panel.tree
	depends = panel.depends
	brotli = panel.brotli
	destination = panel.destination
	status = panel.status
	export_button = panel.export_button
	project_id.text = str(config.get("project_id", "game"))
	var editor_settings := EditorInterface.get_editor_settings()
	brotli.text = (
		str(editor_settings.get_setting("scene_packer/brotli_path"))
		if editor_settings.has_setting("scene_packer/brotli_path")
		else ""
	)
	destination.text = (
		"res://output/scene-packs/" + Time.get_datetime_string_from_system().replace(":", "-")
	)
	panel.add_button.pressed.connect(_add_pack)
	panel.delete_button.pressed.connect(_delete_pack)
	panel.save_button.pressed.connect(
		func() -> void:
			if _save():
				panel.show_message("配置已保存。")
	)
	panel.analyze_button.pressed.connect(_analyze)
	export_button.pressed.connect(_export)
	panel.output_button.pressed.connect(_choose_output)
	panel.brotli_button.pressed.connect(_choose_brotli)
	panel.reload_button.pressed.connect(_request_reload)
	pack_name.text_submitted.connect(func(_text: String) -> void: _add_pack())
	packs.item_selected.connect(_select_pack)
	tree.item_edited.connect(_item_edited)
	panel.search.text_changed.connect(func(_text: String) -> void: _refresh_tree())
	depends.text_submitted.connect(func(_text: String) -> void: _save_options())
	depends.focus_exited.connect(_save_options)
	poll = Timer.new()
	poll.wait_time = 0.5
	poll.timeout.connect(_poll)
	panel.add_child(poll)
	config_watch = Timer.new()
	config_watch.wait_time = 0.75
	config_watch.autostart = true
	config_watch.timeout.connect(_check_external_config)
	panel.add_child(config_watch)
	analysis_timer = Timer.new()
	analysis_timer.one_shot = true
	analysis_timer.wait_time = 0.25
	analysis_timer.timeout.connect(_run_live_analysis)
	panel.add_child(analysis_timer)
	live_analyzer = ANALYZER.new()
	add_control_to_bottom_panel(panel, "场景分包")
	add_tool_menu_item("打开场景分包", func() -> void: make_bottom_panel_item_visible(panel))
	_refresh_packs()
	_queue_analysis()


func _choose_output() -> void:
	var dialog := EditorFileDialog.new()
	dialog.title = "选择版本目录的父目录"
	dialog.file_mode = EditorFileDialog.FILE_MODE_OPEN_DIR
	dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
	panel.add_child(dialog)
	dialog.dir_selected.connect(
		func(path: String) -> void:
			destination.text = path.path_join(
				Time.get_datetime_string_from_system().replace(":", "-")
			)
			dialog.queue_free()
	)
	dialog.canceled.connect(dialog.queue_free)
	dialog.popup_centered_ratio(0.7)


func _choose_brotli() -> void:
	var dialog := EditorFileDialog.new()
	dialog.title = "选择 Brotli 程序"
	dialog.file_mode = EditorFileDialog.FILE_MODE_OPEN_FILE
	dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
	if OS.get_name() == "Windows":
		dialog.filters = PackedStringArray(["*.exe ; 可执行程序"])
	panel.add_child(dialog)
	dialog.file_selected.connect(
		func(path: String) -> void:
			brotli.text = path
			dialog.queue_free()
	)
	dialog.canceled.connect(dialog.queue_free)
	dialog.popup_centered_ratio(0.7)


func _add_pack() -> void:
	var name := pack_name.text.strip_edges()
	if not _save():
		return
	if (
		RegEx.create_from_string("^[a-z][a-z0-9_-]{0,47}$").search(name) == null
		or name == "bootstrap"
		or config.packs.has(name)
	):
		panel.show_message(
			"包名无效或已存在，请更换名称。", "包名须以小写字母开头，只含小写字母、数字、连字符或下划线，不能重复或使用 bootstrap。", true, true
		)
		return
	config.packs[name] = {"paths": [], "depends": []}
	current = name
	pack_name.clear()
	_refresh_packs()
	if _save():
		_queue_analysis()


func _delete_pack() -> void:
	var selected := current
	if not _save() or selected.is_empty() or not config.packs.has(selected):
		return
	config.packs.erase(selected)
	current = ""
	_refresh_packs()
	if _save():
		_queue_analysis()


func _refresh_packs() -> void:
	packs.clear()
	var names: Array = config.packs.keys()
	names.sort()
	for name: String in names:
		packs.add_item(name)
		packs.set_item_metadata(packs.item_count - 1, name)
		packs.set_item_tooltip(packs.item_count - 1, name)
	if not names.is_empty():
		var index := names.find(current)
		if index < 0:
			index = 0
		packs.select(index)
		current = names[index]
		depends.text = ", ".join(config.packs[current].get("depends", []))
	else:
		current = ""
		depends.clear()
	_refresh_tree()


func _select_pack(index: int) -> void:
	var selected := str(packs.get_item_metadata(index))
	if not _save() or not config.packs.has(selected):
		_refresh_packs()
		return
	current = selected
	depends.text = ", ".join(config.packs[current].get("depends", []))
	_update_tree_selection(ANALYZER.new().scan())


func _refresh_tree() -> void:
	var expanded: Dictionary = {}
	var focused := ""
	if tree.get_root() != null:
		_remember_tree(tree.get_root(), expanded)
		if tree.get_selected() != null:
			focused = str(tree.get_selected().get_metadata(0))
	var scroll := tree.get_scroll()
	rebuilding = true
	tree.clear()
	tree_items.clear()
	tree_file_paths.clear()
	var root := tree.create_item()
	var nodes: Dictionary = {"res://": root}
	var query := panel.search.text.strip_edges().to_lower()
	var files: Array[String] = ANALYZER.new().scan()
	tree_files = files
	var selection_index: Dictionary = SELECTION.index(files, config.packs, current)
	_refresh_counts(selection_index)
	for file: String in files:
		if not query.is_empty() and not file.to_lower().contains(query):
			continue
		var segments := file.trim_prefix("res://").split("/")
		var path := "res://"
		for index in segments.size():
			var child_path := path.path_join(segments[index])
			if not nodes.has(child_path):
				var item := tree.create_item(nodes[path])
				item.set_cell_mode(0, TreeItem.CELL_MODE_CHECK)
				item.set_text(0, segments[index])
				item.set_metadata(0, child_path)
				item.collapsed = (
					bool(expanded.get(child_path, index > 0))
					if query == tree_query
					else index > 0 and query.is_empty()
				)
				item.set_text_overrun_behavior(0, TextServer.OVERRUN_TRIM_ELLIPSIS)
				item.set_text_overrun_behavior(1, TextServer.OVERRUN_TRIM_ELLIPSIS)
				var state: Dictionary = selection_index.nodes[child_path]
				var is_file := index == segments.size() - 1
				_configure_tree_item(item, child_path, state, is_file)
				nodes[child_path] = item
				tree_items[child_path] = item
				if is_file:
					tree_file_paths[child_path] = true
				if child_path == focused:
					item.select(0)
			path = child_path
	rebuilding = false
	tree_query = query
	if root.get_child_count() == 0:
		var empty := tree.create_item(root)
		empty.set_text(0, "没有匹配资源" if not query.is_empty() else "工程中没有可选资源")
		empty.set_selectable(0, false)
		empty.set_selectable(1, false)
	for child: Node in tree.get_children(true):
		if child is VScrollBar:
			child.set_deferred("value", scroll.y)
		elif child is HScrollBar:
			child.set_deferred("value", scroll.x)


## 勾选后仅更新已有行，保留滚动、展开与焦点状态。
func _update_tree_selection(files: Array[String]) -> void:
	if files != tree_files:
		_refresh_tree()
		return
	var selection_index: Dictionary = SELECTION.index(files, config.packs, current)
	_refresh_counts(selection_index)
	for path: String in tree_items:
		_configure_tree_item(
			tree_items[path], path, selection_index.nodes[path], tree_file_paths.has(path)
		)


## 同步当前包和左侧包列表中的文件数量。
func _refresh_counts(selection_index: Dictionary) -> void:
	panel.select_pack(current, config.packs.size(), int(selection_index.counts.get(current, 0)))
	for item_index in packs.item_count:
		var id := str(packs.get_item_metadata(item_index))
		packs.set_item_text(item_index, "%s · %s" % [id, selection_index.counts.get(id, 0)])


## 根据完整资源归属更新单行的勾选、禁用和提示状态。
func _configure_tree_item(item: TreeItem, path: String, state: Dictionary, is_file: bool) -> void:
	var next_checked: bool = state.selected < state.total
	var foreign: Array[String] = SELECTION.foreign_owners(state, current)
	item.set_editable(0, SELECTION.can_toggle(state, current, is_file, next_checked))
	item.set_checked(0, state.selected == state.total)
	item.set_indeterminate(0, state.selected > 0 and state.selected < state.total)
	var checkbox_hint := "勾选目录会作用于全部子项。"
	if not foreign.is_empty():
		if not is_file:
			checkbox_hint = "目录包含已归属 %s 的文件，目录勾选已禁用；可展开选择未占用的子项。" % ", ".join(foreign)
		elif state.selected == state.total:
			checkbox_hint = "与 %s 重复归属；可取消当前包的勾选。" % ", ".join(foreign)
		else:
			checkbox_hint = "已归属 %s，当前包不可勾选。" % ", ".join(foreign)
	item.set_tooltip_text(
		0, path + "\n当前包已选 %s / %s 个文件；" % [state.selected, state.total] + checkbox_hint
	)
	var assigned: Array = state.owners.keys()
	assigned.sort()
	var labels: Array[String] = []
	for id: String in assigned:
		labels.append(id + ("（部分）" if state.owners[id] < state.total else ""))
	var owner_text := ", ".join(labels) if not labels.is_empty() else "未分配"
	item.set_text(1, owner_text)
	item.set_tooltip_text(1, owner_text)
	if state.conflicts > 0:
		item.set_custom_color(1, panel.get_theme_color("error_color", "Editor"))
		item.set_tooltip_text(1, owner_text + "\n%s 个文件存在重复归属。" % state.conflicts)
	else:
		item.clear_custom_color(1)


func _remember_tree(item: TreeItem, expanded: Dictionary) -> void:
	var path: Variant = item.get_metadata(0)
	if path is String:
		expanded[path] = item.collapsed
	for child: TreeItem in item.get_children():
		_remember_tree(child, expanded)


func _item_edited() -> void:
	if rebuilding or current.is_empty():
		return
	var item := tree.get_edited()
	if item == null or not item.get_metadata(0) is String:
		return
	# Tree blocks clear/create during its mouse signal. Capture values, never retain
	# the TreeItem, and apply after input dispatch so all children can refresh safely.
	_set_resource_checked.call_deferred(str(item.get_metadata(0)), item.is_checked(0), current)


func _set_resource_checked(path: String, checked: bool, selected: String) -> void:
	if closing or selected != current or not _save() or not config.packs.has(selected):
		return
	# 延迟处理前重新扫描完整资源树，避免筛选或外部配置更新导致重复归属。
	var files: Array[String] = ANALYZER.new().scan()
	var selection_index: Dictionary = SELECTION.index(files, config.packs, selected)
	if (
		not selection_index.nodes.has(path)
		or not SELECTION.can_toggle(selection_index.nodes[path], selected, files.has(path), checked)
	):
		_refresh_tree()
		return
	config.packs[selected] = SELECTION.toggle(config.packs[selected], path, checked)
	if not _save():
		_refresh_tree()
		return
	_update_tree_selection(files)
	_queue_analysis()


func _queue_analysis() -> void:
	if closing or pid > 0:
		return
	if not analysis_queued:
		panel.report.clear()
		panel.summary.text = "正在更新依赖与体积…"
		panel.show_message("选择已保存，正在更新依赖与体积…")
	analysis_queued = true
	analysis_timer.start()


func _save_options() -> void:
	if _save():
		_queue_analysis()


func _run_live_analysis() -> void:
	analysis_queued = false
	if closing or syncing or pid > 0:
		return
	_present_analysis(live_analyzer.analyze(_capture_config()), false)


func _capture_config() -> Dictionary:
	var draft := config.duplicate(true)
	draft.project_id = project_id.text.strip_edges()
	# Retire the old per-export entry without changing the engine's project settings.
	draft.erase("entry_scene")
	if not current.is_empty() and draft.packs.has(current):
		var dependencies: Array[String] = []
		for dependency: String in depends.text.split(",", false):
			if dependency.strip_edges() not in dependencies:
				dependencies.append(dependency.strip_edges())
		dependencies.sort()
		draft.packs[current].depends = dependencies
	return draft


func _read_disk() -> Dictionary:
	var text := FileAccess.get_file_as_string(CONFIG) if FileAccess.file_exists(CONFIG) else ""
	var parser := JSON.new()
	if parser.parse(text) != OK:
		return {"ok": false}
	var parsed: Variant = parser.data
	if not parsed is Dictionary or not parsed.get("packs") is Dictionary:
		return {"ok": false}
	for definition: Variant in parsed.packs.values():
		if (
			not definition is Dictionary
			or not definition.get("paths", []) is Array
			or not definition.get("depends", []) is Array
			or not definition.get("excludes", []) is Array
		):
			return {"ok": false}
	return {"ok": true, "value": parsed, "hash": text.sha256_text()}


func _apply_config(value: Dictionary, remote: Dictionary, hash_value: String) -> void:
	syncing = true
	config = value.duplicate(true)
	baseline = remote.duplicate(true)
	disk_hash = hash_value
	project_id.text = str(config.get("project_id", ""))
	_refresh_packs()
	panel.report.clear()
	panel.show_message("已读取外部更新的配置，请重新分析。", "配置文件：" + ProjectSettings.globalize_path(CONFIG), true)
	syncing = false


func _sync_external_config() -> bool:
	var current_hash := FileAccess.get_sha256(CONFIG) if FileAccess.file_exists(CONFIG) else ""
	if current_hash == disk_hash:
		return true
	var incoming := _read_disk()
	if not incoming.ok:
		panel.show_message(
			"磁盘配置无效，已停止保存。", "scene_packs.json 已被修改或删除，请修复文件后重试。面板不会覆盖它。", true, true
		)
		return false
	# A script hot reload can introduce the tracking fields into an older instance.
	# Treat its existing stored configuration as the baseline, not a local edit.
	var base := config if baseline.is_empty() else baseline
	var merged: Dictionary = CONFIG_SYNC.merge(base, _capture_config(), incoming.value)
	if not merged.conflicts.is_empty():
		panel.show_message(
			"配置存在编辑冲突，已停止保存。",
			"这些字段在磁盘和面板中都有修改：\n" + "\n".join(merged.conflicts) + "\n可在导出设置中点击“重新读取”，使用磁盘配置。",
			true,
			true
		)
		return false
	_apply_config(merged.value, incoming.value, incoming.hash)
	return true


func _check_external_config() -> void:
	if closing or syncing or pid > 0:
		return
	var previous_hash := disk_hash
	if _sync_external_config() and previous_hash != disk_hash:
		_present_analysis(ANALYZER.new().analyze(_capture_config()))


func _request_reload() -> void:
	if _capture_config() == baseline:
		_reload_config()
		return
	var dialog := ConfirmationDialog.new()
	dialog.title = "重新读取分包配置"
	dialog.dialog_text = "磁盘配置将替换面板中尚未保存的修改。"
	dialog.ok_button_text = "重新读取"
	panel.add_child(dialog)
	dialog.confirmed.connect(
		func() -> void:
			_reload_config()
			dialog.queue_free()
	)
	dialog.canceled.connect(dialog.queue_free)
	dialog.popup_centered()


func _reload_config() -> void:
	var incoming := _read_disk()
	if not incoming.ok:
		panel.show_message("无法读取有效的 scene_packs.json。", "", false, true)
		return
	_apply_config(incoming.value, incoming.value, incoming.hash)
	_present_analysis(ANALYZER.new().analyze(config))


func _save() -> bool:
	if closing or syncing or not _sync_external_config():
		return false
	config = _capture_config()
	var file := FileAccess.open(CONFIG, FileAccess.WRITE)
	if file == null:
		panel.show_message("无法保存分包配置，请检查项目目录权限。", "", false, true)
		return false
	file.store_string(JSON.stringify(config, "\t", true, false) + "\n")
	file.close()
	disk_hash = FileAccess.get_sha256(CONFIG)
	baseline = config.duplicate(true)
	EditorInterface.get_editor_settings().set_setting(
		"scene_packer/brotli_path", brotli.text.strip_edges()
	)
	return true


func _analyze() -> Dictionary:
	if not _save():
		return {"errors": ["配置保存失败。"]}
	analysis_timer.stop()
	analysis_queued = false
	var report: Dictionary = ANALYZER.new().analyze(config)
	_present_analysis(report)
	return report


func _present_analysis(report: Dictionary, reveal: bool = true) -> void:
	panel.show_analysis(report)
	if not report.errors.is_empty():
		panel.show_message(
			"发现 %s 项问题，请修正后导出。" % report.errors.size(), "\n".join(report.errors), reveal, true
		)
	else:
		var lines: Array[String] = ["验证通过。依赖顺序：" + " → ".join(report.order)]
		lines.append(
			(
				"启动包：bootstrap, %s；源文件合计 %s（压缩体积导出后显示）。"
				% [
					", ".join(report.get("startup_packs", [])),
					String.humanize_size(report.get("startup_bytes", 0))
				]
			)
		)
		lines.append("bootstrap → " + ", ".join(report.get("bootstrap_depends", [])))
		for chain: Array in report.get("startup_traces", {}).values():
			lines.append("启动依赖：" + " → ".join(chain))
		for id: String in report.order:
			lines.append(
				(
					"%s：%s 个文件，源文件 %s；依赖 %s"
					% [
						id,
						report.packs[id].size(),
						String.humanize_size(report.sizes[id]),
						", ".join(report.depends[id])
					]
				)
			)
		panel.show_message("验证通过 · 涉及 %s 个资源包。" % report.order.size(), "\n".join(lines), reveal)

	panel.summary.text = panel.notice.text
	panel.summary.tooltip_text = panel.notice.tooltip_text


## 验证配置后启动后台导出并初始化面板进度。
func _export() -> void:
	if pid > 0:
		return
	var analysis: Dictionary = _analyze()
	if not analysis.errors.is_empty():
		return
	EditorInterface.save_all_scenes()
	var cache := OS.get_cache_dir().path_join("scene-packer")
	DirAccess.make_dir_recursive_absolute(cache)
	var stem := str(Time.get_ticks_usec())
	result_path = cache.path_join(stem + ".json")
	log_path = cache.path_join(stem + ".log")
	log_offset = 0
	var args := PackedStringArray(
		[
			"--headless",
			"--path",
			ProjectSettings.globalize_path("res://"),
			"--log-file",
			log_path,
			"--script",
			"res://addons/scene_packer/export_job.gd",
			"--",
			"--config",
			ProjectSettings.globalize_path(CONFIG),
			"--output",
			ProjectSettings.globalize_path(destination.text),
			"--result",
			result_path
		]
	)
	if not brotli.text.strip_edges().is_empty():
		args.append_array(["--brotli", brotli.text.strip_edges()])
	pid = OS.create_process(OS.get_executable_path(), args, false)
	if pid < 0:
		panel.show_message("无法启动导出进程。", "", true, true)
		return
	panel.set_busy(true)
	panel.start_export_progress(6 + analysis.order.size() + 1)
	poll.start()


## 只读取后台日志新增的完整行，并接受结构化的进度事件。
func _read_export_progress() -> void:
	if not FileAccess.file_exists(log_path):
		return
	var file := FileAccess.open(log_path, FileAccess.READ)
	if file == null:
		return
	var length := file.get_length()
	if length < log_offset:
		log_offset = 0
	file.seek(log_offset)
	var latest: Dictionary = {}
	while file.get_position() < length:
		var start := file.get_position()
		var line := file.get_line()
		if file.get_position() == length:
			# 末尾未换行的日志可能还在写入，下轮从该行重新读取。
			file.seek(length - 1)
			if file.get_8() != 10:
				log_offset = start
				break
		log_offset = file.get_position()
		var at := line.find("SCENE_PACKS_PROGRESS ")
		if at < 0:
			continue
		var event: Variant = JSON.parse_string(line.substr(at + "SCENE_PACKS_PROGRESS ".length()))
		if not event is Dictionary:
			continue
		if (
			not (event.get("done") is float or event.get("done") is int)
			or not (event.get("total") is float or event.get("total") is int)
			or not event.get("stage") is String
		):
			continue
		latest = event
	file.close()
	if not latest.is_empty():
		panel.show_export_progress(int(latest.done), int(latest.total), str(latest.stage))


## 更新面板进度，并在工作进程结束时展示最终产物或错误。
func _poll() -> void:
	_read_export_progress()
	if OS.is_process_running(pid):
		return
	poll.stop()
	pid = -1
	panel.set_busy(false)
	var result: Variant = (
		JSON.parse_string(FileAccess.get_file_as_string(result_path))
		if FileAccess.file_exists(result_path)
		else null
	)
	if not result is Dictionary:
		panel.finish_export_progress(false)
		panel.show_message("导出进程异常结束。", "日志：" + log_path, true, true)
	elif not result.ok:
		panel.finish_export_progress(false)
		panel.show_message("导出失败，请查看详细信息。", str(result.error), true, true)
	else:
		panel.finish_export_progress(true)
		panel.show_export(result.manifest)
		panel.show_message(
			"导出完成 · %s 个压缩包。" % result.manifest.packs.size(),
			"输出目录：" + result.output + "\n包含 manifest.json 和 .pck.br，可按目录结构上传。",
			true
		)


func _exit_tree() -> void:
	closing = true
	if is_instance_valid(config_watch):
		config_watch.stop()
	if is_instance_valid(analysis_timer):
		analysis_timer.stop()
	remove_tool_menu_item("打开场景分包")
	remove_control_from_bottom_panel(panel)
	panel.queue_free()
