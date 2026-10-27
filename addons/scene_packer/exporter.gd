@tool
extends RefCounted
## Runs only in the export worker, never blocks the editor UI.
const ANALYZER = preload("res://addons/scene_packer/analyzer.gd")
var error: String = ""
var workspace: String = ""
var source_root: String = ""
var snapshots: Dictionary = {}

func export_project(config: Dictionary, output: String, brotli: String) -> Dictionary:
	var environment: Dictionary = {}
	for key: String in ["TEMP", "TMP", "TMPDIR"]:
		environment[key] = OS.get_environment(key) if OS.has_environment(key) else null
	var result := _export(config, output, brotli)
	for key: String in environment:
		if environment[key] == null:
			OS.unset_environment(key)
		else:
			OS.set_environment(key, environment[key])
	if not workspace.is_empty():
		_remove_tree(workspace)
	return result

## 在隔离副本中执行完整导出，并按实际完成的阶段报告进度。
func _export(config: Dictionary, output: String, brotli: String) -> Dictionary:
	var analysis: Dictionary = ANALYZER.new().analyze(config)
	if not analysis.errors.is_empty():
		return {"ok": false, "error": "\n".join(analysis.errors)}
	if str(config.get("project_id", "")).is_empty():
		return {"ok": false, "error": "请填写稳定的项目标识。"}
	if not output.is_absolute_path():
		output = "res://".path_join(output)
	output = ProjectSettings.globalize_path(output).simplify_path()
	if DirAccess.dir_exists_absolute(output) or FileAccess.file_exists(output):
		return {"ok": false, "error": "输出路径已存在，请选择新的版本目录：" + output}
	if brotli.is_empty():
		brotli = "brotli"
	if not _execute(brotli, ["--version"]):
		return {"ok": false, "error": "找不到 Brotli，请设置可执行文件路径。\n" + error}
	var total_steps: int = 6 + analysis.order.size() + 1 # 固定步骤和 bootstrap/业务包。
	_emit_progress(0, total_steps, "正在复制项目")
	source_root = ProjectSettings.globalize_path("res://").trim_suffix("/")
	DirAccess.make_dir_recursive_absolute(output.get_base_dir())
	workspace = output.get_base_dir().path_join(".scene-packer-%s-%s" % [OS.get_process_id(), Time.get_ticks_usec()])
	var stage := workspace.path_join("project")
	var product := workspace.path_join("product")
	DirAccess.make_dir_recursive_absolute(stage)
	DirAccess.make_dir_recursive_absolute(product.path_join("packs"))
	# Godot's ZIP exporter uses a fixed "packtmp" name in the OS temp directory.
	# Give every worker its own temp root, including concurrent exports from other projects.
	var temporary := workspace.path_join("tmp")
	DirAccess.make_dir_recursive_absolute(temporary)
	for key: String in ["TEMP", "TMP", "TMPDIR"]:
		OS.set_environment(key, temporary)
	print("SCENE_PACKS_STAGE 创建独立导出副本")
	if not _copy_project(source_root, stage, output):
		return {"ok": false, "error": error}
	_emit_progress(1, total_steps, "正在准备导入")
	var settings := ConfigFile.new()
	if settings.load(stage.path_join("project.godot")) != OK:
		return {"ok": false, "error": "无法读取项目配置。"}
	# Godot's binary scene conversion instantiates/re-packs scenes, baking inherited
	# transforms into parents. Keep authored scene references so changing B does not
	# mutate A. Official texture/GLB import and compiled GDScript export still apply.
	settings.set_value("editor", "export/convert_text_resources_to_binary", false)
	settings.set_value("editor_plugins", "enabled", PackedStringArray())
	settings.set_value("autoload", "__ScenePackReady", "*res://__scene_packer_ready.gd")
	if settings.save(stage.path_join("project.godot")) != OK:
		return {"ok": false, "error": "无法写入导出副本配置。"}
	DirAccess.copy_absolute(source_root.path_join("addons/scene_packer/runtime_ready.gd"), stage.path_join("__scene_packer_ready.gd"))
	var presets := ConfigFile.new()
	var original := ConfigFile.new()
	original.load("res://export_presets.cfg")
	var original_section := ""
	for section: String in original.get_sections():
		if original.get_value(section, "platform", "") == "Web":
			original_section = section
			break
	if not original_section.is_empty():
		for key: String in original.get_section_keys(original_section + ".options"):
			presets.set_value("preset.0.options", key, original.get_value(original_section + ".options", key))
	presets.set_value("preset.0", "name", "Scene Packs")
	presets.set_value("preset.0", "platform", "Web")
	presets.set_value("preset.0", "runnable", false)
	presets.set_value("preset.0", "export_filter", "resources")
	presets.set_value("preset.0", "exclude_filter", "")
	var export_files := PackedStringArray(["res://__scene_packer_ready.gd"])
	var includes := PackedStringArray()
	for id: String in analysis.order:
		for file: String in analysis.packs[id]:
			export_files.append(file)
			includes.append(file.trim_prefix("res://"))
	presets.set_value("preset.0", "export_files", export_files)
	presets.set_value("preset.0", "include_filter", ",".join(includes))
	presets.set_value("preset.0", "script_export_mode", 2)
	presets.set_value("preset.0.options", "variant/thread_support", false)
	presets.set_value("preset.0.options", "vram_texture_compression/for_desktop", true)
	presets.set_value("preset.0.options", "vram_texture_compression/for_mobile", true)
	presets.save(stage.path_join("export_presets.cfg"))
	print("SCENE_PACKS_STAGE 导入资源")
	var executable := OS.get_executable_path()
	# On a fresh checkout the editor creates Autoloads before importing textures.
	# Import first without them, then restore and validate the real startup scripts.
	var import_settings := ConfigFile.new()
	import_settings.load(stage.path_join("project.godot"))
	import_settings.erase_section("autoload")
	import_settings.save(stage.path_join("project.godot"))
	_emit_progress(1, total_steps, "正在导入资源（1/2）")
	if not _execute(executable, ["--headless", "--path", stage, "--editor", "--import", "--quit"]):
		return {"ok": false, "error": error}
	_emit_progress(2, total_steps, "正在导入资源（2/2）")
	settings.save(stage.path_join("project.godot"))
	if not _execute(executable, ["--headless", "--path", stage, "--editor", "--import", "--quit"]):
		return {"ok": false, "error": error}
	_emit_progress(3, total_steps, "正在执行 Web 导出")
	print("SCENE_PACKS_STAGE 官方 Web 导出")
	var zip_path := workspace.path_join("export.zip")
	if not _execute(executable, ["--headless", "--path", stage, "--export-pack", "Scene Packs", zip_path]):
		return {"ok": false, "error": error}
	_emit_progress(4, total_steps, "正在整理导出文件")
	var zip := ZIPReader.new()
	if zip.open(zip_path) != OK:
		return {"ok": false, "error": "无法读取官方导出 ZIP。"}
	var archive := zip.get_files()
	archive.sort()
	var emitted: Dictionary = {}
	var scene_outputs: Dictionary = {}
	var buckets: Dictionary = {"bootstrap": []}
	for id: String in analysis.order:
		buckets[id] = []
	for file: String in archive:
		var resource := "res://" + file
		var owner := str(analysis.owners.get(resource, ""))
		for suffix: String in [".import", ".remap", ".uid"]:
			if file.ends_with(suffix):
				owner = str(analysis.owners.get(resource.trim_suffix(suffix), owner))
		if file.begins_with("__scene_packer_ready.gd") or file in ["project.binary", ".godot/global_script_class_cache.cfg", ".godot/uid_cache.bin", ".godot/extension_list.cfg"]:
			owner = "bootstrap"
		if not owner.is_empty() and buckets.has(owner):
			emitted[file] = owner
			if file.ends_with(".scn") or file.ends_with(".tscn"):
				scene_outputs[resource] = file
			if file.ends_with(".import") or file.ends_with(".remap"):
				var mapping := ConfigFile.new()
				if mapping.parse(zip.read_file(file).get_string_from_utf8()) != OK:
					zip.close()
					return {"ok": false, "error": "导入映射损坏：" + file}
				for section: String in mapping.get_sections():
					if section not in ["remap", "deps"]:
						continue
					for key: String in mapping.get_section_keys(section):
						if key == "source_file":
							continue
						var value: Variant = mapping.get_value(section, key)
						var paths: Array = [value] if value is String else Array(value) if value is PackedStringArray else []
						for path: Variant in paths:
							if str(path).begins_with("res://"):
								emitted[str(path).trim_prefix("res://")] = owner
								if str(path).ends_with(".scn"):
									scene_outputs[resource.trim_suffix(".import").trim_suffix(".remap")] = str(path).trim_prefix("res://")
	var extracted := workspace.path_join("unpacked")
	for file: String in archive:
		if not emitted.has(file):
			zip.close()
			return {"ok": false, "error": "导出产物未归属到包，请补充分包规则：res://" + file}
		var destination := extracted.path_join(file)
		DirAccess.make_dir_recursive_absolute(destination.get_base_dir())
		var handle := FileAccess.open(destination, FileAccess.WRITE)
		if handle == null:
			zip.close()
			return {"ok": false, "error": "无法写入临时导出文件：" + file}
		var data := zip.read_file(file)
		if file == ".godot/global_script_class_cache.cfg":
			var global_classes := ConfigFile.new()
			global_classes.parse(data.get_string_from_utf8())
			var selected_classes: Array = []
			for item: Dictionary in global_classes.get_value("", "list", []):
				if analysis.owners.has(str(item.path)) and buckets.has(analysis.owners[str(item.path)]):
					selected_classes.append(item)
			global_classes.set_value("", "list", selected_classes)
			data = global_classes.encode_to_text().to_utf8_buffer()
		handle.store_buffer(data)
		handle.close()
		buckets[emitted[file]].append(file)
	zip.close()
	var normalization := workspace.path_join("scene-outputs.json")
	var normalization_file := FileAccess.open(normalization, FileAccess.WRITE)
	normalization_file.store_string(JSON.stringify(scene_outputs))
	normalization_file.close()
	var isolated_config := FileAccess.open(extracted.path_join("project.godot"), FileAccess.WRITE)
	isolated_config.store_string("config_version=5\n")
	isolated_config.close()
	print("SCENE_PACKS_STAGE 固定导出场景节点标识")
	_emit_progress(4, total_steps, "正在规范化场景")
	if not _execute(executable, ["--headless", "--path", extracted, "--script", source_root.path_join("addons/scene_packer/normalize_scenes.gd"), "--", normalization]):
		return {"ok": false, "error": error}
	var version := Engine.get_version_info()
	var manifest := {"schema": 3, "project_id": config.project_id,
		"engine_version": "%s.%s.%s" % [version.major, version.minor, version.patch],
		"project_scene": analysis.project_scene, "scene_override": analysis.scene_override, "bootstrap": "bootstrap",
		"scene_to_pack": analysis.scene_to_pack, "packs": {}}
	var pack_ids: Array = buckets.keys()
	pack_ids.sort()
	_emit_progress(5, total_steps, "正在打包（0/%s）" % pack_ids.size())
	var completed_packs := 0
	for id: String in pack_ids:
		print("SCENE_PACKS_STAGE 打包与 Brotli 压缩：", id)
		var pck := workspace.path_join(id + ".pck")
		var packer := PCKPacker.new()
		if packer.pck_start(pck) != OK:
			return {"ok": false, "error": "无法创建 PCK：" + id}
		buckets[id].sort()
		for file: String in buckets[id]:
			if packer.add_file(file, extracted.path_join(file)) != OK:
				return {"ok": false, "error": "PCK 写入失败：" + file}
		if packer.flush() != OK:
			return {"ok": false, "error": "PCK 完成失败：" + id}
		var compressed := workspace.path_join(id + ".br")
		if not _execute(brotli, ["-q", "11", "-f", "-o", compressed, pck]):
			return {"ok": false, "error": error}
		var restored := workspace.path_join(id + ".verify.pck")
		if not _execute(brotli, ["-d", "-f", "-o", restored, compressed]) or FileAccess.get_sha256(restored) != FileAccess.get_sha256(pck):
			return {"ok": false, "error": "Brotli 回读校验失败：" + id + "\n" + error}
		var br_hash := FileAccess.get_sha256(compressed)
		var relative := "packs/%s-%s.pck.br" % [id, br_hash]
		if DirAccess.copy_absolute(compressed, product.path_join(relative)) != OK:
			return {"ok": false, "error": "无法保存压缩包：" + relative}
		manifest.packs[id] = {"url": relative, "compression": "br", "br_sha256": br_hash,
			"br_size": FileAccess.open(compressed, FileAccess.READ).get_length(),
			"pck_sha256": FileAccess.get_sha256(pck), "pck_size": FileAccess.open(pck, FileAccess.READ).get_length(),
			"depends": analysis.bootstrap_depends if id == "bootstrap" else analysis.depends[id],
			"files": [] if id == "bootstrap" else analysis.packs[id], "archive_files": buckets[id]}
		completed_packs += 1
		_emit_progress(5 + completed_packs, total_steps, "正在打包（%s/%s）" % [completed_packs, pack_ids.size()] if completed_packs < pack_ids.size() else "正在生成清单")
	for path: String in snapshots:
		if FileAccess.get_sha256(path) != snapshots[path]:
			return {"ok": false, "error": "导出期间源文件发生变化，请重新导出：" + path}
	manifest["release_id"] = JSON.stringify(manifest, "", true, false).sha256_text()
	var manifest_file := FileAccess.open(product.path_join("manifest.json"), FileAccess.WRITE)
	manifest_file.store_string(JSON.stringify(manifest, "\t", true, false) + "\n")
	manifest_file.close()
	if DirAccess.rename_absolute(product, output) != OK:
		return {"ok": false, "error": "无法发布输出目录：" + output}
	print("SCENE_PACKS_EXPORTED ", output)
	return {"ok": true, "output": output, "manifest": manifest}

## 向编辑器发送已完成步骤；同一步骤可更新当前阶段而不虚增进度。
func _emit_progress(done: int, total: int, stage: String) -> void:
	print("SCENE_PACKS_PROGRESS " + JSON.stringify({"done": done, "total": total, "stage": stage}))

func _execute(executable: String, arguments: PackedStringArray) -> bool:
	var captured: Array = []
	var code := OS.execute(executable, arguments, captured, true, false)
	var log := "\n".join(captured)
	if not log.is_empty():
		print(log)
	if code != 0 or "SCRIPT ERROR:" in log or "ERROR:" in log:
		error = "命令失败（%s）：%s\n%s" % [code, executable, log]
		return false
	return true

func _copy_project(source: String, target: String, output: String) -> bool:
	var dir := DirAccess.open(source)
	if dir == null:
		error = "无法读取源目录：" + source
		return false
	DirAccess.make_dir_recursive_absolute(target)
	for name: String in dir.get_files():
		if name.begins_with(".") and name != ".gdignore":
			continue
		var path := source.path_join(name)
		snapshots[path] = FileAccess.get_sha256(path)
		if DirAccess.copy_absolute(path, target.path_join(name)) != OK:
			error = "复制失败：" + path
			return false
	for name: String in dir.get_directories():
		var path := source.path_join(name)
		if name.begins_with(".") or name in ANALYZER.IGNORED or path == output or path == workspace or name == "__pycache__":
			continue
		if not _copy_project(path, target.path_join(name), output):
			return false
	return true

func _remove_tree(path: String) -> void:
	# Never remove source/output paths; only descendants of our unique workspace.
	if workspace.is_empty() or (path != workspace and not path.begins_with(workspace + "/")):
		return
	var dir := DirAccess.open(path)
	if dir == null:
		return
	for file: String in dir.get_files():
		DirAccess.remove_absolute(path.path_join(file))
	for child: String in dir.get_directories():
		_remove_tree(path.path_join(child))
	DirAccess.remove_absolute(path)
