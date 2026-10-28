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
	var files: Array[String] = [
		"res://assets/new.png", "res://assets/nested/a.png", "res://assets/nested/b.png"
	]
	var groups := {"a": definition, "b": {"paths": ["res://assets/nested/b.png"]}}
	var index: Dictionary = RULES.index(files, groups, "a")
	assert(index.nodes["res://assets"].selected == 2)
	assert(index.nodes["res://assets"].total == 3)
	assert(
		index.nodes["res://assets"].conflicts == 0,
		"Different children in two packs are not duplicates"
	)
	assert(index.counts == {"a": 2, "b": 1})
	groups.b.paths.append("res://assets/new.png")
	assert(RULES.index(files, groups, "a").nodes["res://assets"].conflicts == 1)
	var blocked: Dictionary = RULES.index(files, groups, "b")
	assert(RULES.foreign_owners(blocked.nodes["res://assets"], "b") == ["a"])
	assert(
		not RULES.can_toggle(blocked.nodes["res://assets"], "b", false, true),
		"Mixed directory must be disabled"
	)
	assert(
		not RULES.can_toggle(blocked.nodes["res://assets/nested/a.png"], "b", true, true),
		"Other package's file must be disabled"
	)
	assert(
		RULES.can_toggle(blocked.nodes["res://assets/nested/b.png"], "b", true, false),
		"Current package's file remains removable"
	)
	assert(
		RULES.can_toggle(blocked.nodes["res://assets/new.png"], "b", true, false),
		"Existing overlap must be removable"
	)
	assert(
		not RULES.can_toggle(blocked.nodes["res://assets/new.png"], "b", true, true),
		"Existing overlap cannot be selected again"
	)
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
