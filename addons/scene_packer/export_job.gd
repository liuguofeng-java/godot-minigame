extends SceneTree

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var options: Dictionary = {}
	var args := OS.get_cmdline_user_args()
	var index := 0
	while index + 1 < args.size():
		options[args[index].trim_prefix("--")] = args[index + 1]
		index += 2
	var config_path: String = options.get("config", "res://scene_packs.json")
	var config: Variant = JSON.parse_string(FileAccess.get_file_as_string(config_path))
	var result: Dictionary
	if not config is Dictionary or not options.has("output"):
		result = {"ok": false, "error": "需要有效的 --config JSON 和 --output 新目录。"}
	else:
		result = load("res://addons/scene_packer/exporter.gd").new().export_project(config, options.output, options.get("brotli", "brotli"))
	if options.has("result"):
		var file := FileAccess.open(options.result, FileAccess.WRITE)
		if file != null:
			file.store_string(JSON.stringify(result, "\t", true, false))
	if not result.ok:
		printerr(result.error)
	quit(0 if result.ok else 1)
