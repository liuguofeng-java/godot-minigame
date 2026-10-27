extends SceneTree

const RULES = preload("res://addons/scene_packer/selection_rules.gd")

func _initialize() -> void:
	var definition: Dictionary = {"paths": [], "depends": ["shared"]}
	definition = RULES.toggle(definition, "res://assets", true)
	assert(RULES.selected(definition, "res://assets/new.png"))
	assert(not RULES.selected(definition, "res://assets-other/new.png"))
	definition = RULES.toggle(definition, "res://assets/nested", false)
	assert(not RULES.selected(definition, "res://assets/nested/a.png"))
	assert(RULES.selected(definition, "res://assets/new.png"))
	definition = RULES.toggle(definition, "res://assets/nested/a.png", true)
	assert(RULES.selected(definition, "res://assets/nested/a.png"))
	assert(not RULES.selected(definition, "res://assets/nested/b.png"))
	assert(definition.depends == ["shared"])
	var files: Array[String] = ["res://assets/new.png", "res://assets/nested/a.png", "res://assets/nested/b.png"]
	var groups := {"a": definition, "b": {"paths": ["res://assets/nested/b.png"]}}
	var index: Dictionary = RULES.index(files, groups, "a")
	assert(index.nodes["res://assets"].selected == 2)
	assert(index.nodes["res://assets"].total == 3)
	assert(index.nodes["res://assets"].conflicts == 0, "Different children in two packs are not duplicates")
	assert(index.counts == {"a": 2, "b": 1})
	groups.b.paths.append("res://assets/new.png")
	assert(RULES.index(files, groups, "a").nodes["res://assets"].conflicts == 1)
	definition = RULES.toggle(definition, "res://assets", false)
	for file: String in files:
		assert(not RULES.selected(definition, file), "Parent uncheck must remove child overrides")
	assert(definition.paths.is_empty() and not definition.has("excludes"))
	definition = RULES.toggle(definition, "res://assets/nested/a.png", true)
	definition = RULES.toggle(definition, "res://assets", true)
	assert(definition.paths == ["res://assets"])
	assert(RULES.selected(definition, "res://assets/nested/future.png"))
	assert(not RULES.selected({"paths": ["res://assets/"], "excludes": ["res://assets"]}, files[0]))
	assert(RULES.selected({"paths": ["res://"]}, files[0]))
	print("SCENE_PACKER_SELECTION_RULES_VERIFIED")
	quit()
