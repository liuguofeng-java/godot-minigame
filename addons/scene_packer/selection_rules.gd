@tool
extends RefCounted
## A more specific include/exclude rule overrides an ancestor rule.
## Directory includes keep discovering new files even after excluding one child.


static func covers(rule: String, path: String) -> bool:
	rule = rule.trim_suffix("/") if rule != "res://" else rule
	return path == rule or path.begins_with(rule if rule == "res://" else rule + "/")


## 更具体的路径覆盖父级规则；同一深度的排除规则优先。
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


## 修改父级时移除其下所有例外，使筛选后的可见节点和隐藏节点保持一致。
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


## 返回当前包以外已选中该文件或目录内文件的资源包。
static func foreign_owners(state: Dictionary, active: String) -> Array[String]:
	var result: Array[String] = []
	var owners: Dictionary = state.get("owners", {})
	for id: String in owners:
		if id != active:
			result.append(id)
	result.sort()
	return result


## 目录含外包资源时禁止整目录操作；重复归属的单文件只允许从当前包取消。
static func can_toggle(state: Dictionary, active: String, is_file: bool, checked: bool) -> bool:
	if active.is_empty():
		return false
	if foreign_owners(state, active).is_empty():
		return true
	return is_file and not checked and int(state.get("selected", 0)) == int(state.get("total", 0))
