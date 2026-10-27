extends SceneTree

const PANEL = preload("res://addons/scene_packer/packer_panel.gd")

func _initialize() -> void:
	verify.call_deferred()

func settle() -> void:
	for frame in 8:
		await process_frame

func verify() -> void:
	for scale_factor: float in [1.0, 1.5]:
		var panel = PANEL.new(scale_factor)
		panel.theme = load("res://preview_theme.res").duplicate() if FileAccess.file_exists("res://preview_theme.res") else ThemeDB.get_default_theme().duplicate()
		panel.theme.default_font_size = int(16 * scale_factor)
		root.add_child(panel)
		panel.project_id.text = "poison-island"
		panel.destination.text = "res://output/builds/scene-packs/poison-island"
		for id: String in ["environment", "gameplay", "shared"]:
			panel.packs.add_item(id)
		panel.select_pack("gameplay", 3, 18)
		for dimensions: Vector2 in [Vector2(600, 300), Vector2(1000, 420), Vector2(1700, 480)]:
			var requested := dimensions * scale_factor
			for tab in 3:
				panel.tabs.current_tab = tab
				panel.size = requested
				await settle()
				if panel.size.x > requested.x + 1 or panel.size.y > requested.y + 1:
					push_error("Panel exceeds requested size: %s / %s, tab %s" % [panel.size, requested, tab])
					quit(1); return
				for control: Control in [panel.tabs, panel.save_button, panel.analyze_button, panel.export_button]:
					var rect := control.get_global_rect()
					if not panel.get_global_rect().grow(1).encloses(rect):
						push_error("Control clipped: %s at %s" % [control.name, rect])
						quit(1); return
				if tab == 0 and panel.tree.size.y < 70 * scale_factor:
					push_error("Resource tree has no usable space"); quit(1); return
		panel.show_analysis({"order": ["a"], "packs": {"a": ["res://a.tscn"]}, "sizes": {"a": 1024}, "depends": {"a": []}})
		panel.show_message("发现 1 项问题", "res://a.tscn → res://missing.png：未分配到包。", true, true)
		if panel.tabs.current_tab != 2 or panel.report.get_root().get_child_count() != 1:
			push_error("Analysis results were not shown"); quit(1); return
		panel.start_export_progress(9)
		panel.show_export_progress(4, 9, "正在整理导出文件")
		if not panel.progress_row.visible or panel.progress_bar.value != 4 or panel.progress_count.text != "4/9 步":
			push_error("Export progress was not shown"); quit(1); return
		panel.finish_export_progress(false)
		if panel.progress_bar.value != 4 or panel.progress_label.text != "导出中断":
			push_error("Failed export lost its last completed step"); quit(1); return
		panel.start_export_progress(8)
		if panel.progress_bar.value != 0 or panel.progress_count.text != "0/8 步":
			push_error("New export kept stale progress"); quit(1); return
		panel.finish_export_progress(true)
		if panel.progress_bar.value != 8 or panel.progress_label.text != "导出完成":
			push_error("Completed export did not fill progress"); quit(1); return
		panel.show_analysis({"order": ["a"], "packs": {"a": ["res://a.tscn"]}, "sizes": {"a": 1024}, "depends": {"a": []}})
		if panel.progress_row.visible:
			push_error("Analysis left the old export progress visible"); quit(1); return
		panel.set_busy(true)
		if not panel.export_button.disabled or not panel.analyze_button.disabled:
			push_error("Export controls are not locked while running"); quit(1); return
		panel.set_busy(false)
		panel.free()
	print("SCENE_PACKER_PANEL_VERIFIED sizes=3 scales=2 tabs=3")
	quit()
