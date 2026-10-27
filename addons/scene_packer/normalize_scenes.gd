extends SceneTree
## Godot 4.7 generates random editor recovery IDs when packing/importing scenes.
## Canonicalize both IDs and references together, after official export, without
## instantiating gameplay or changing node paths, properties, meshes or scripts.
func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var config: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(OS.get_cmdline_user_args()[0]))
	var scenes: Dictionary = {}
	var replacements: Dictionary = {}
	var used: Dictionary = {}
	var paths: Array = config.keys()
	paths.sort()
	for path: String in paths:
		var scene := load(path) as PackedScene
		if scene == null:
			push_error("Cannot normalize exported scene: " + path)
			quit(1)
			return
		scenes[path] = scene
		var bundle: Dictionary = scene.get("_bundled")
		var ids: PackedInt32Array = bundle.get("node_ids", PackedInt32Array())
		for index in ids.size():
			var previous := ids[index]
			if previous <= 0 or replacements.has(previous):
				continue
			var identity := path + ":" + str(scene.get_state().get_node_path(index))
			var replacement := int(identity.sha256_text().substr(0, 8).hex_to_int() & 0x7fffffff)
			while replacement == 0 or used.has(replacement):
				replacement = (replacement + 1) & 0x7fffffff
			replacements[previous] = replacement
			used[replacement] = true
	for path: String in paths:
		var scene: PackedScene = scenes[path]
		var bundle: Dictionary = scene.get("_bundled")
		var ids: PackedInt32Array = bundle.get("node_ids", PackedInt32Array())
		for index in ids.size():
			ids[index] = replacements.get(ids[index], ids[index])
		bundle["node_ids"] = ids
		var id_paths: Array = bundle.get("id_paths", [])
		for path_index in id_paths.size():
			var id_path: PackedInt32Array = id_paths[path_index]
			for index in id_path.size():
				id_path[index] = replacements.get(id_path[index], id_path[index])
			id_paths[path_index] = id_path
		bundle["id_paths"] = id_paths
		scene.set("_bundled", bundle)
	for path: String in paths:
		if ResourceSaver.save(scenes[path], "res://" + str(config[path])) != OK:
			push_error("Cannot save canonical scene: " + path)
			quit(1)
			return
	print("SCENE_PACK_IDS_NORMALIZED ", paths.size())
	quit()
