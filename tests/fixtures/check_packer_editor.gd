@tool
extends EditorPlugin

func _enter_tree() -> void:
	_run.call_deferred()

func _find(node: Node) -> Node:
	if node.name == "ScenePackerPanel":
		return node
	for child: Node in node.get_children():
		var found := _find(child)
		if found != null:
			return found
	return null

func _run() -> void:
	for frame in 10:
		await get_tree().process_frame
	var panel = _find(get_tree().root)
	if panel == null:
		push_error("Scene pack plugin was not enabled"); get_tree().quit(1); return
	var plugin = panel.add_button.pressed.get_connections()[0].callable.get_object()
	panel.pack_name.text = "new_pack"
	panel.add_button.pressed.emit()
	if plugin.current != "new_pack" or not plugin.config.packs.has("new_pack"):
		push_error("Add pack signal failed"); get_tree().quit(1); return
	panel.delete_button.pressed.emit()
	if plugin.config.packs.has("new_pack"):
		push_error("Delete pack signal failed"); get_tree().quit(1); return
	panel.search.text = "B.tscn"
	panel.search.text_changed.emit(panel.search.text)
	if panel.tree.get_root().get_child_count() != 1 or panel.tree.get_root().get_first_child().get_text(0) != "b":
		var names: Array = []
		for item: TreeItem in panel.tree.get_root().get_children():
			names.append(item.get_text(0))
		push_error("Resource filter did not isolate B: " + str(names) + " query=" + panel.search.text); get_tree().quit(1); return
	panel.search.text = ""
	panel.search.text_changed.emit("")
	panel.analyze_button.pressed.emit()
	if panel.tabs.current_tab != 2 or panel.report.get_root().get_child_count() != 2:
		push_error("Analyze action did not show the pack table"); get_tree().quit(1); return
	panel.save_button.pressed.emit()
	var saved = JSON.parse_string(FileAccess.get_file_as_string("res://scene_packs.json"))
	assert(not saved.has("entry_scene"), "Obsolete plugin entry must be retired on save")
	if saved.packs.size() != 2:
		push_error("Saved configuration changed unexpectedly"); get_tree().quit(1); return
	await _verify_tree(plugin, panel)
	_write_config(saved)
	plugin._reload_config()
	# Reproduce the reported bug: a loaded cyclic config is fixed on disk, then
	# Analyze used to write the stale in-memory cycle back before reading it.
	var cyclic: Dictionary = saved.duplicate(true)
	cyclic.packs.b.depends = ["a"]
	_write_config(cyclic)
	plugin._reload_config()
	if plugin._analyze().errors.is_empty():
		push_error("Cycle fixture was not reproduced"); get_tree().quit(1); return
	panel.project_id.text = "local-project-edit"
	_write_config(saved)
	var repaired: Dictionary = plugin._analyze()
	var disk: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://scene_packs.json"))
	if not repaired.errors.is_empty() or not disk.packs.b.depends.is_empty() or disk.project_id != "local-project-edit":
		push_error("Analyze overwrote the external fix or lost an independent local edit"); get_tree().quit(1); return
	# New tracking properties can be empty in an old instance after script reload.
	plugin.baseline = {}
	plugin.disk_hash = ""
	plugin.config.packs.b.depends = ["a"]
	if not plugin._analyze().errors.is_empty():
		push_error("Hot-reloaded plugin retained its stale cached cycle"); get_tree().quit(1); return
	# The watcher refreshes an open panel without requiring plugin reactivation.
	disk.project_id = "external-project-edit"
	_write_config(disk)
	for frame in 150:
		if panel.project_id.text == "external-project-edit":
			break
		await get_tree().process_frame
	if panel.project_id.text != "external-project-edit":
		push_error("Open panel did not follow external config changes"); get_tree().quit(1); return
	# Concurrent edits to the same field are blocked, keeping both copies intact.
	panel.project_id.text = "unsaved-local"
	disk.project_id = "conflicting-remote"
	_write_config(disk)
	if plugin._save() or panel.project_id.text != "unsaved-local":
		push_error("Same-field conflict was silently overwritten"); get_tree().quit(1); return
	if JSON.parse_string(FileAccess.get_file_as_string("res://scene_packs.json")).project_id != "conflicting-remote":
		push_error("Conflict changed the disk configuration"); get_tree().quit(1); return
	plugin._reload_config()
	var corrupt := FileAccess.open("res://scene_packs.json", FileAccess.WRITE)
	corrupt.store_string("{")
	corrupt.close()
	if plugin._save() or FileAccess.get_file_as_string("res://scene_packs.json") != "{":
		push_error("Invalid external JSON was overwritten"); get_tree().quit(1); return
	_write_config(disk)
	plugin._reload_config()
	plugin.closing = true
	panel.project_id.text = "stale-on-close"
	panel.depends.focus_exited.emit()
	if JSON.parse_string(FileAccess.get_file_as_string("res://scene_packs.json")).project_id != "conflicting-remote":
		push_error("Plugin shutdown wrote stale fields"); get_tree().quit(1); return
	plugin.closing = false
	plugin._reload_config()
	print("SCENE_PACKER_EXTERNAL_CONFIG_VERIFIED")
	var preview_theme := Theme.new()
	preview_theme.merge_with(EditorInterface.get_editor_theme())
	if ResourceSaver.save(preview_theme, "res://preview_theme.res") != OK:
		push_error("Cannot capture native editor theme"); get_tree().quit(1); return
	print("SCENE_PACKER_EDITOR_ACTIONS_VERIFIED")
	get_tree().quit()

func _write_config(value: Dictionary) -> void:
	var file := FileAccess.open("res://scene_packs.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(value, "\t", true, false) + "\n")
	file.close()

func _item(tree: Tree, path: String, parent: TreeItem = null) -> TreeItem:
	if parent == null:
		parent = tree.get_root()
	for child: TreeItem in parent.get_children():
		if child.get_metadata(0) == path:
			return child
		var found := _item(tree, path, child)
		if found != null:
			return found
	return null

func _frames() -> void:
	for frame in 4:
		await get_tree().process_frame

func _click(tree: Tree, path: String) -> void:
	var item := _item(tree, path)
	assert(item != null, "Missing tree item: " + path)
	var parent := item.get_parent()
	while parent != null:
		parent.collapsed = false
		parent = parent.get_parent()
	tree.scroll_to_item(item)
	await _frames()
	var area := tree.get_item_area_rect(item, 0)
	# Click the label area, away from the folding arrow, through normal GUI input.
	var local := area.position + Vector2(minf(110, area.size.x * 0.6), area.size.y / 2)
	assert(tree.get_item_at_position(local) == item, "Mouse target does not match " + path)
	var point := tree.get_global_transform_with_canvas() * local
	var motion := InputEventMouseMotion.new()
	motion.position = point
	tree.get_viewport().push_input(motion)
	for pressed: bool in [true, false]:
		var event := InputEventMouseButton.new()
		event.button_index = MOUSE_BUTTON_LEFT
		event.pressed = pressed
		event.position = point
		tree.get_viewport().push_input(event)
	await _frames()

func _verify_tree(plugin, panel) -> void:
	plugin.make_bottom_panel_item_visible(panel)
	panel.tabs.current_tab = 0
	await _frames()
	assert(plugin.current == "a")
	assert(_item(panel.tree, "res://a").is_checked(0))
	assert(_item(panel.tree, "res://a/nested/one.txt").is_editable(0))
	await _click(panel.tree, "res://a/nested/one.txt")
	assert(not _item(panel.tree, "res://a/nested/one.txt").is_checked(0), "Child mouse click was not saved")
	assert(_item(panel.tree, "res://a/nested").is_indeterminate(0))
	assert(_item(panel.tree, "res://a").is_indeterminate(0))
	assert(not _item(panel.tree, "res://a/nested").collapsed, "Expansion lost after selection")
	assert(panel.resource_title.text.contains("2"), "Selected-file count is stale")
	assert(panel.packs.get_item_text(0) == "a · 2")
	assert(panel.tabs.current_tab == 0, "Live analysis switched tabs")
	var row: TreeItem = panel.report.get_root().get_first_child()
	while row != null and row.get_text(0) != "a":
		row = row.get_next()
	assert(row != null and row.get_text(1) == "2", "Analysis table did not update automatically")
	var disk: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://scene_packs.json"))
	assert(disk.packs.a.excludes == ["res://a/nested/one.txt"])
	var report: Dictionary = plugin.ANALYZER.new().analyze(disk)
	assert(report.packs.a.size() == 2 and not report.owners.has("res://a/nested/one.txt"))
	# All existing children selected restores the parent check, keeping new-file inclusion.
	await _click(panel.tree, "res://a/nested/one.txt")
	assert(_item(panel.tree, "res://a").is_checked(0))
	assert(not _item(panel.tree, "res://a").is_indeterminate(0))
	assert(not plugin.config.packs.a.has("excludes"))
	await _click(panel.tree, "res://a/nested")
	assert(not _item(panel.tree, "res://a/nested/one.txt").is_checked(0))
	assert(not _item(panel.tree, "res://a/nested/two.txt").is_checked(0))
	await _click(panel.tree, "res://a/nested/one.txt")
	assert(_item(panel.tree, "res://a/nested").is_indeterminate(0))
	# A filtered parent still operates on hidden descendants.
	panel.search.text = "one.txt"
	panel.search.text_changed.emit(panel.search.text)
	await _frames()
	assert(_item(panel.tree, "res://a/nested").is_indeterminate(0))
	await _click(panel.tree, "res://a/nested")
	assert(plugin.SELECTION.selected(plugin.config.packs.a, "res://a/nested/two.txt"))
	await _click(panel.tree, "res://a/nested")
	assert(not plugin.SELECTION.selected(plugin.config.packs.a, "res://a/nested/two.txt"))
	panel.search.text = ""
	panel.search.text_changed.emit("")
	await _frames()
	await _click(panel.tree, "res://a")
	assert(_item(panel.tree, "res://a/nested/one.txt").is_checked(0))
	await _click(panel.tree, "res://a")
	assert(not _item(panel.tree, "res://a/nested/two.txt").is_checked(0))
	assert(plugin.config.packs.a.paths.is_empty())
	assert(panel.notice.text.contains("问题"), "Missing entry ownership did not update validation")
	await _click(panel.tree, "res://a")
	assert(panel.notice.text.contains("验证通过"), "Restored selection left stale validation errors")
	panel.tabs.current_tab = 1
	panel.depends.text = "missing_pack"
	panel.depends.text_submitted.emit(panel.depends.text)
	await _frames()
	assert(panel.notice.text.contains("问题") and panel.status.text.contains("missing_pack"))
	assert(panel.tabs.current_tab == 1)
	panel.depends.text = "b"
	panel.depends.text_submitted.emit(panel.depends.text)
	await _frames()
	assert(panel.notice.text.contains("验证通过"))
	print("SCENE_PACKER_MOUSE_SELECTION_AND_LIVE_ANALYSIS_VERIFIED")
