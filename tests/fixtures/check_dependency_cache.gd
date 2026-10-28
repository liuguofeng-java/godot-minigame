extends SceneTree

const ANALYZER = preload("res://addons/scene_packer/analyzer.gd")


## 连续分析须复用未变依赖，同时发现同一秒内保存的等长脚本修改。
func _initialize() -> void:
	var path := "res://a/ref.gd"
	_write_source(path, "res://b/B.tscn")
	var config := {
		"packs":
		{"a": {"paths": ["res://a"], "depends": []}, "b": {"paths": ["res://b"], "depends": []}}
	}
	var analyzer = ANALYZER.new()
	analyzer.analyze(config)
	assert("res://b/B.tscn" in analyzer.dependencies[path])
	_write_source(path, "res://b/C.tscn")
	analyzer.analyze(config)
	assert(
		"res://b/C.tscn" in analyzer.dependencies[path], "Changed script dependency remained cached"
	)
	assert("res://b/B.tscn" not in analyzer.dependencies[path])
	print("SCENE_PACKER_DEPENDENCY_CACHE_VERIFIED")
	quit()


## 只在临时验证工程内写入测试脚本。
func _write_source(path: String, target: String) -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_string('extends Node\nconst TARGET = "' + target + '"\n')
	file.close()
