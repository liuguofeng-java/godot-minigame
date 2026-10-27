@tool
extends RefCounted
## Pure analysis: paths retain their res:// identity; no resources are modified.

const RESERVED := ["bootstrap"]
const SELECTION = preload("res://addons/scene_packer/selection_rules.gd")
const IGNORED := [".git", ".godot", "output", "build", "dist", "node_modules"]
var errors: Array[String] = []
var owners: Dictionary = {}
var members: Dictionary = {}
var graph: Dictionary = {}
## 同一分析器实例内缓存资源依赖及其源文件签名，供连续面板更新复用。
var dependencies: Dictionary = {}
## 资源路径对应的修改时间或文本内容哈希。
var dependency_signatures: Dictionary = {}
var classes: Dictionary = {}
var files: Array[String] = []
var extra: Dictionary = {}
var traces: Dictionary = {}
var pack_traces: Dictionary = {}

func scan(root: String = "res://") -> Array[String]:
	var result: Array[String] = []
	var directory := DirAccess.open(root)
	if directory == null:
		return result
	for name in directory.get_files():
		if not name.begins_with(".") and not name.ends_with(".import") and not name.ends_with(".uid") and name != "export_presets.cfg" and name != "project.godot" and name != "scene_packs.json":
			result.append(root.path_join(name))
	for name in directory.get_directories():
		var child := root.path_join(name)
		if name.begins_with(".") or name in IGNORED or child == "res://addons/scene_packer" or FileAccess.file_exists(child.path_join(".gdignore")):
			continue
		result.append_array(scan(child))
	result.sort()
	return result

func _editor_plugin_resource(path: String) -> bool:
	var parent := path.get_base_dir()
	while parent.begins_with("res://addons/"):
		if FileAccess.file_exists(parent.path_join("plugin.cfg")):
			return true
		parent = parent.get_base_dir()
	return false

func analyze(config: Dictionary) -> Dictionary:
	var previous_files := files
	var previous_classes := classes.duplicate()
	errors.clear()
	owners.clear()
	members.clear()
	graph.clear()
	classes.clear()
	extra.clear()
	traces.clear()
	pack_traces.clear()
	files = scan()
	for item: Dictionary in ProjectSettings.get_global_class_list():
		classes[str(item["class"])] = str(item["path"])
	# 文件增删或全局类变化会影响未修改脚本中的隐式引用。
	if files != previous_files or classes != previous_classes:
		dependencies.clear()
		dependency_signatures.clear()
	var pattern := RegEx.create_from_string("^[a-z][a-z0-9_-]{0,47}$")
	var groups: Variant = config.get("packs", {})
	if not groups is Dictionary or groups.is_empty():
		return {"errors": ["请先创建资源包。"]}
	for id: String in groups:
		if pattern.search(id) == null or id in RESERVED:
			errors.append("包名无效或保留：" + id)
		members[id] = []
		graph[id] = []
		var definition: Variant = groups[id]
		if not definition is Dictionary:
			errors.append("包配置不是对象：" + id)
			continue
		extra[id] = definition.get("depends", [])
		for selection: String in definition.get("paths", []):
			if not selection.begins_with("res://") or ".." in selection.split("/"):
				errors.append("无效资源路径：" + selection)
				continue
			var is_directory := DirAccess.dir_exists_absolute(selection)
			var matched := false
			for file: String in files:
				if file == selection or (is_directory and file.begins_with(selection.trim_suffix("/") + "/")):
					matched = true
					if not SELECTION.selected(definition, file):
						continue
					if owners.has(file) and owners[file] != id:
						errors.append("重复归属：%s → %s、%s" % [file, owners[file], id])
					else:
						owners[file] = id
						if file not in members[id]:
							members[id].append(file)
			if not matched:
				errors.append("选择为空、不存在或被排除：" + selection)
		for exclusion: String in definition.get("excludes", []):
			if not exclusion.begins_with("res://") or ".." in exclusion.split("/"):
				errors.append("无效排除路径：" + exclusion)
	var roots: Array[String] = []
	# Project-level resources and Autoloads must exist before game initialization.
	var project_config := ConfigFile.new()
	project_config.load("res://project.godot")
	# This is engine metadata, never a separate plugin setting or an export filter.
	var project_scene := _resolve(str(project_config.get_value("application", "run/main_scene", "")))
	for section: String in project_config.get_sections():
		if section.begins_with("editor") or section == "scene_packer":
			continue
		for key: String in project_config.get_section_keys(section):
			if section == "application" and key == "run/main_scene":
				continue
			_collect_setting(project_config.get_value(section, key), roots)
	var active: Dictionary = {}
	var pending: Array = []
	var boot_dependencies: Array[String] = []
	for path: String in roots:
		_require(path, "项目启动资源", active, pending)
		if owners.has(path) and owners[path] not in boot_dependencies:
			boot_dependencies.append(owners[path])
	# Every scene is independently runnable; even orphan scenes must be assigned.
	var scene_files: Array[String] = []
	for path: String in files:
		if path.ends_with(".tscn") or path.ends_with(".scn"):
			# Editor plugin panels are not game levels. Runtime addon resources are
			# still checked when assigned, referenced, or used as the engine default.
			if _editor_plugin_resource(path) and not owners.has(path) and path != project_scene:
				continue
			scene_files.append(path)
			_require(path, "项目场景", active, pending)
	if not project_scene.is_empty() and project_scene not in scene_files:
		errors.append("项目默认场景不存在或不在可导出范围：" + project_scene)
	# Include and validate all packs, including packs no scene currently references.
	for id: String in members:
		if not active.has(id):
			active[id] = true
			pending.append(id)
	while not pending.is_empty():
		var id: String = pending.pop_front()
		for dep: String in extra.get(id, []):
			if not members.has(dep):
				errors.append("%s → 未知附加依赖包 %s" % [id, dep])
				continue
			if not pack_traces.has(dep):
				pack_traces[dep] = Array(pack_traces.get(id, [])) + ["包 %s 的附加依赖 %s" % [id, dep]]
			_add_edge(id, dep, active, pending)
		for file: String in members[id]:
			for dependency: String in _dependencies(file):
				_require(dependency, file, active, pending)
				if owners.has(dependency):
					_add_edge(id, owners[dependency], active, pending)
	var order: Array[String] = []
	var visiting: Array[String] = []
	var visited: Dictionary = {}
	var ids: Array = active.keys()
	ids.sort()
	for id: String in ids:
		_visit(id, visiting, visited, order)
	var selected: Dictionary = {}
	var sizes: Dictionary = {}
	var scenes: Dictionary = {}
	for id: String in order:
		members[id].sort()
		graph[id].sort()
		selected[id] = members[id]
		sizes[id] = 0
		for file: String in members[id]:
			var opened := FileAccess.open(file, FileAccess.READ)
			if opened != null:
				sizes[id] += opened.get_length()
			if file.ends_with(".tscn") or file.ends_with(".scn"):
				scenes[file] = id
	boot_dependencies.sort()
	return {"errors": errors.duplicate(), "owners": owners.duplicate(), "packs": selected,
		"depends": graph.duplicate(true), "order": order, "sizes": sizes,
		"scene_to_pack": scenes, "bootstrap_depends": boot_dependencies, "project_scene": project_scene,
		"scene_override": not bool(project_config.get_value("application", "config/disable_project_settings_override", false))}

func _collect_setting(value: Variant, result: Array[String]) -> void:
	if value is String or value is StringName:
		var path := str(value).trim_prefix("*")
		if path.begins_with("uid://"):
			path = _resolve(path)
		if path.begins_with("res://") and path not in result:
			result.append(path)
	elif value is Array or value is PackedStringArray:
		for item: Variant in value:
			_collect_setting(item, result)
	elif value is Dictionary:
		for item: Variant in value.values():
			_collect_setting(item, result)

func _resolve(path: String) -> String:
	if "::" in path:
		path = path.get_slice("::", path.get_slice_count("::") - 1)
	if path.begins_with("uid://"):
		var id := ResourceUID.text_to_id(path)
		if ResourceUID.has_id(id):
			return ResourceUID.get_id_path(id)
	return path

func _dependencies(path: String) -> Array[String]:
	var signature := str(FileAccess.get_modified_time(path))
	if path.ends_with(".gd") or path.ends_with(".gdshader") or path.ends_with(".gdshaderinc") or path.ends_with(".tscn") or path.ends_with(".tres"):
		# 同一秒内保存文本资源时，内容哈希仍可识别依赖变化。
		signature += ":" + FileAccess.get_sha256(path)
	if dependencies.has(path) and dependency_signatures.get(path, "") == signature:
		return dependencies[path]
	var result: Array[String] = []
	if ResourceLoader.exists(path):
		for raw: String in ResourceLoader.get_dependencies(path):
			var resolved := _resolve(raw)
			if resolved != path and resolved not in result:
				result.append(resolved)
	if path.ends_with(".gd") or path.ends_with(".gdshader") or path.ends_with(".gdshaderinc"):
		var source := _mask_source(FileAccess.get_file_as_string(path), not path.ends_with(".gd"), false)
		var paths := RegEx.create_from_string("[\"']((?:res|uid)://[^\"']+)[\"']")
		for match_result: RegExMatch in paths.search_all(source):
			if _dynamic_suffix(source.substr(match_result.get_end()).strip_edges()):
				continue
			var resolved := _resolve(match_result.get_string(1))
			# A directory prefix in a dynamically assembled path is not a resource.
			# Its runtime targets must be covered by explicit pack dependencies.
			if resolved.ends_with("/") or DirAccess.dir_exists_absolute(resolved):
				continue
			if resolved != path and resolved not in result:
				result.append(resolved)
		var relative_paths := RegEx.create_from_string("(?:\\b(?:preload|load)\\s*\\(\\s*|\\bextends\\s+|#include\\s+)[\"']([^\"']+)[\"']")
		for match_result: RegExMatch in relative_paths.search_all(source):
			if _dynamic_suffix(source.substr(match_result.get_end()).strip_edges()):
				continue
			var relative := match_result.get_string(1)
			if relative.contains("://") or relative.is_absolute_path() or relative.ends_with("/"):
				continue
			var resolved := path.get_base_dir().path_join(relative).simplify_path()
			if resolved != path and resolved not in result:
				result.append(resolved)
		# Global script classes are implicit references, absent from scene ext_resources.
		var words := RegEx.create_from_string("\\b[A-Za-z_][A-Za-z0-9_]*\\b")
		for word: RegExMatch in words.search_all(_mask_source(source, not path.ends_with(".gd"), true)):
			var name := word.get_string()
			if classes.has(name) and classes[name] != path and classes[name] not in result:
				result.append(classes[name])
	result.sort()
	dependencies[path] = result
	dependency_signatures[path] = signature
	return result

func _dynamic_suffix(tail: String) -> bool:
	return tail.begins_with("+") or tail.begins_with("%") or tail.begins_with(".format(")

func _mask_source(source: String, shader: bool, mask_strings: bool) -> String:
	# Preserve character positions and newlines while hiding comments (and, for
	# class-name analysis, strings). Quoted res:// paths must survive // detection.
	var result := ""
	var index := 0
	while index < source.length():
		var character := source[index]
		if character == "\"" or character == "'":
			var delimiter := character.repeat(3) if source.substr(index, 3) == character.repeat(3) else character
			var end := index + delimiter.length()
			while end < source.length():
				if source[end] == "\\":
					end += 2
				elif source.substr(end, delimiter.length()) == delimiter:
					end += delimiter.length()
					break
				else:
					end += 1
			var literal := source.substr(index, end - index)
			result += RegEx.create_from_string("[^\\n]").sub(literal, " ", true) if mask_strings else literal
			index = end
		elif (not shader and character == "#") or (shader and source.substr(index, 2) == "//"):
			while index < source.length() and source[index] != "\n":
				result += " "
				index += 1
		elif shader and source.substr(index, 2) == "/*":
			var end := source.find("*/", index + 2)
			end = source.length() if end < 0 else end + 2
			result += RegEx.create_from_string("[^\\n]").sub(source.substr(index, end - index), " ", true)
			index = end
		else:
			result += character
			index += 1
	return result

func _require(path: String, origin: String, active: Dictionary, pending: Array) -> void:
	var chain: Array = Array(traces.get(origin, [])).duplicate()
	if chain.is_empty():
		if owners.has(origin) and pack_traces.has(owners[origin]):
			chain = Array(pack_traces[owners[origin]]).duplicate()
			chain.append("包 %s 的选中资源" % owners[origin])
		chain.append(origin)
	chain.append(path)
	if not traces.has(path):
		traces[path] = chain
	if not FileAccess.file_exists(path):
		errors.append("%s：资源不存在。" % " → ".join(chain))
	elif not owners.has(path):
		errors.append("%s：未分配到包。" % " → ".join(chain))
	else:
		var id: String = owners[path]
		if not pack_traces.has(id):
			pack_traces[id] = chain
		if not active.has(id):
			active[id] = true
			pending.append(id)

func _add_edge(id: String, dep: String, active: Dictionary, pending: Array) -> void:
	if id != dep and dep not in graph[id]:
		graph[id].append(dep)
	if not active.has(dep):
		active[dep] = true
		pending.append(dep)

func _visit(id: String, visiting: Array[String], visited: Dictionary, order: Array[String]) -> void:
	if id in visiting:
		errors.append("包间循环依赖：" + " → ".join(visiting + [id]))
		return
	if visited.has(id):
		return
	visiting.append(id)
	for dep: String in graph[id]:
		_visit(dep, visiting, visited, order)
	visiting.pop_back()
	visited[id] = true
	order.append(id)
