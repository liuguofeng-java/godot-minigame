@tool
extends RefCounted
## Merge independent edits; never resolve concurrent edits to the same field silently.


static func merge(
	base: Dictionary, local: Dictionary, remote: Dictionary, prefix: String = ""
) -> Dictionary:
	var value: Dictionary = {}
	var conflicts: Array[String] = []
	var keys: Array = base.keys()
	for key: String in local:
		if key not in keys:
			keys.append(key)
	for key: String in remote:
		if key not in keys:
			keys.append(key)
	keys.sort()
	for key: String in keys:
		var local_unchanged: bool = (
			local.has(key) == base.has(key) and local.get(key) == base.get(key)
		)
		var remote_unchanged: bool = (
			remote.has(key) == base.has(key) and remote.get(key) == base.get(key)
		)
		var same: bool = local.has(key) == remote.has(key) and local.get(key) == remote.get(key)
		if local_unchanged:
			if remote.has(key):
				value[key] = remote[key]
		elif remote_unchanged or same:
			if local.has(key):
				value[key] = local[key]
		elif (
			base.get(key) is Dictionary
			and local.get(key) is Dictionary
			and remote.get(key) is Dictionary
		):
			var nested := merge(base[key], local[key], remote[key], prefix + key + ".")
			value[key] = nested.value
			conflicts.append_array(nested.conflicts)
		else:
			conflicts.append(prefix + key)
			if local.has(key):
				value[key] = local[key]
	return {"value": value, "conflicts": conflicts}
