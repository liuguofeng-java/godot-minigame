@tool
extends RefCounted
## A more specific include/exclude rule overrides an ancestor rule.
## Directory includes keep discovering new files even after excluding one child.

static func covers(rule: String, path: String) -> bool:
	rule = rule.trim_suffix("/") if rule != "res://" else rule
	return path == rule or path.begins_with(rule if rule == "res://" else rule + "/")

static func selected(definition: Dictionary, path: String) -> bool:
	var depth := -1
	var included := false
	for rule: String in definition.get("paths", []):
		rule = rule.trim_suffix("/") if rule != "res://" else rule
		if rule.length() > depth and covers(rule, path):
			depth = rule.length()
			included = true
	for rule: String in definition.get("excludes", []):
		rule = rule.trim_suffix("/") if rule != "res://" else rule
		if rule.length() >= depth and covers(rule, path):
			depth = rule.length()
			included = false
	return included

static func toggle(definition: Dictionary, path: String, checked: bool) -> Dictionary:
	var result := definition.duplicate(true)
	path = path.trim_suffix("/") if path != "res://" else path
	# Clicking a parent replaces all rules below it, including hidden search results.
	for field: String in ["paths", "excludes"]:
		var retained: Array[String] = []
		for rule: String in result.get(field, []):
			rule = rule.trim_suffix("/") if rule != "res://" else rule
			if not covers(path, rule):
				retained.append(rule)
		result[field] = retained
	if selected(result, path) != checked:
		result["paths" if checked else "excludes"].append(path)
	result.paths.sort()
	result.excludes.sort()
	if result.excludes.is_empty():
		result.erase("excludes")
	return result

static func index(files: Array[String], groups: Dictionary, active: String) -> Dictionary:
	var nodes: Dictionary = {}
	var counts: Dictionary = {}
	for id: String in groups:
		counts[id] = 0
	for file: String in files:
		var owners: Array[String] = []
		for id: String in groups:
			if selected(groups[id], file):
				owners.append(id)
				counts[id] += 1
		owners.sort()
		var path := "res://"
		for segment: String in file.trim_prefix("res://").split("/"):
			path = path.path_join(segment)
			if not nodes.has(path):
				nodes[path] = {"total": 0, "selected": 0, "owners": {}, "conflicts": 0}
			var state: Dictionary = nodes[path]
			state.total += 1
			if active in owners:
				state.selected += 1
			if owners.size() > 1:
				state.conflicts += 1
			for id: String in owners:
				state.owners[id] = int(state.owners.get(id, 0)) + 1
	return {"nodes": nodes, "counts": counts}
