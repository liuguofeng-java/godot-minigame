@tool
extends VBoxContainer
## Native editor controls, kept separate from export/configuration behavior.

var tabs: TabContainer
var packs: ItemList
var pack_count: Label
var pack_name: LineEdit
var add_button: Button
var delete_button: Button
var resource_title: Label
var resource_hint: Label
var search: LineEdit
var tree: Tree
var depends: LineEdit
var project_id: LineEdit
var destination: LineEdit
var output_button: Button
var brotli: LineEdit
var brotli_button: Button
var summary: Label
## 导出过程中显示已完成步骤和当前阶段。
var progress_row: HBoxContainer
## 显示当前阶段名称。
var progress_label: Label
## 显示按已完成步骤计算的进度。
var progress_bar: ProgressBar
## 显示已完成步骤和总步骤数。
var progress_count: Label
var report: Tree
var status: TextEdit
var notice: Label
var save_button: Button
var analyze_button: Button
var export_button: Button
var reload_button: Button
var _scale := 1.0

func _init(editor_scale: float = 1.0) -> void:
	_scale = editor_scale
	name = "ScenePackerPanel"
	custom_minimum_size = Vector2(600, 300) * _scale
	add_theme_constant_override("separation", int(6 * _scale))
	tabs = TabContainer.new()
	tabs.size_flags_vertical = Control.SIZE_EXPAND_FILL
	# Inactive pages must not force the resource workspace to the settings page's height.
	tabs.use_hidden_tabs_for_min_size = false
	add_child(tabs)
	_build_resources()
	_build_settings()
	_build_results()
	var actions := _row(self)
	notice = _label(actions, "选择资源包后勾选文件或目录。")
	notice.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	notice.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	notice.custom_minimum_size.x = 40 * _scale
	save_button = _button(actions, "保存配置")
	analyze_button = _button(actions, "分析依赖")
	export_button = _button(actions, "导出 .pck.br")
	export_button.tooltip_text = "检查整个项目的场景与资源依赖，导出全部配置的资源包。"

func _page(title: String) -> VBoxContainer:
	var margin := MarginContainer.new()
	margin.name = title
	for edge: String in ["left", "top", "right", "bottom"]:
		margin.add_theme_constant_override("margin_" + edge, int(8 * _scale))
	tabs.add_child(margin)
	var content := VBoxContainer.new()
	content.add_theme_constant_override("separation", int(6 * _scale))
	margin.add_child(content)
	return content

func _build_resources() -> void:
	var page := _page("资源分包")
	var split := HSplitContainer.new()
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	page.add_child(split)
	var left := VBoxContainer.new()
	left.custom_minimum_size.x = 190 * _scale
	left.add_theme_constant_override("separation", int(6 * _scale))
	split.add_child(left)
	var heading := _row(left)
	pack_count = _label(heading, "资源包 · 0")
	pack_count.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	delete_button = _button(heading, "删除")
	delete_button.tooltip_text = "删除当前包定义，源文件保留。"
	var create_row := _row(left)
	pack_name = _line_edit(create_row, "新包名称，例如 gameplay")
	pack_name.tooltip_text = "以小写字母开头，可使用数字、连字符和下划线。"
	add_button = _button(create_row, "添加")
	packs = ItemList.new()
	packs.size_flags_vertical = Control.SIZE_EXPAND_FILL
	packs.custom_minimum_size.y = 56 * _scale
	packs.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	left.add_child(packs)
	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.add_theme_constant_override("separation", int(6 * _scale))
	split.add_child(right)
	var resources_heading := _row(right)
	resource_title = _label(resources_heading, "资源文件")
	resource_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	resource_title.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	search = _line_edit(resources_heading, "筛选文件或路径")
	search.clear_button_enabled = true
	tree = Tree.new()
	tree.columns = 2
	tree.set_column_title(0, "文件 / 目录")
	tree.set_column_title(1, "所属包")
	tree.set_column_expand_ratio(0, 3)
	tree.set_column_expand_ratio(1, 1)
	tree.set_column_custom_minimum_width(1, int(80 * _scale))
	tree.column_titles_visible = true
	tree.size_flags_vertical = Control.SIZE_EXPAND_FILL
	tree.custom_minimum_size.y = 72 * _scale
	tree.hide_root = true
	right.add_child(tree)
	tree.tooltip_text = "父级勾选会联动全部子项；取消子项后父级显示半选。选择后自动更新归属、数量和依赖。"

func _build_settings() -> void:
	var page := _page("导出设置")
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	page.add_child(scroll)
	var form := VBoxContainer.new()
	form.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	form.add_theme_constant_override("separation", int(12 * _scale))
	scroll.add_child(form)
	var config_row := _form_row(form, "配置文件")
	var config_label := _label(config_row, "scene_packs.json")
	config_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	reload_button = _button(config_row, "重新读取")
	reload_button.tooltip_text = "重新读取磁盘配置并分析依赖；外部修改也会自动同步。"
	var project_row := _form_row(form, "项目标识")
	project_id = _line_edit(project_row, "用于区分项目缓存，发布后请保持稳定")
	_note(form, "导出整个项目的全部资源包，检查所有场景依赖。运行场景由引擎或业务代码决定。")
	var output_row := _form_row(form, "输出目录")
	destination = _line_edit(output_row, "选择一个尚不存在的版本目录")
	output_button = _button(output_row, "选择父目录…")
	_note(form, "每次导出使用新目录，产物为 manifest.json 和 .pck.br。")
	var brotli_row := _form_row(form, "Brotli 程序")
	brotli = _line_edit(brotli_row, "留空时从 PATH 查找")
	brotli_button = _button(brotli_row, "浏览…")
	_note(form, "压缩等级固定为 11；程序路径仅保存在本机编辑器设置中。")
	form.add_child(HSeparator.new())
	var dependency_row := _form_row(form, "包附加依赖")
	depends = _line_edit(dependency_row, "包名，用逗号分隔")
	depends.tooltip_text = "动态路径无法自动推断时，在此声明当前资源包需要一起加载的包。"
	resource_hint = _label(form, "先在资源分包页选择一个包。")
	resource_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	resource_hint.modulate.a = 0.75

## 建立分析结果页和后台导出的进度栏。
func _build_results() -> void:
	var page := _page("分析结果")
	summary = _label(page, "尚未分析。配置资源包后，点击“分析依赖”检查整个项目。")
	summary.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	progress_row = _row(page)
	progress_row.visible = false
	progress_label = _label(progress_row, "准备导出")
	progress_label.custom_minimum_size.x = 120 * _scale
	progress_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	progress_bar = ProgressBar.new()
	progress_bar.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	progress_bar.show_percentage = false
	progress_row.add_child(progress_bar)
	progress_count = _label(progress_row, "0/0 步")
	var split := VSplitContainer.new()
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	page.add_child(split)
	report = Tree.new()
	report.columns = 5
	var titles := ["资源包", "文件数", "源文件 / PCK", "Brotli", "依赖包"]
	for index in titles.size():
		report.set_column_title(index, titles[index])
		report.set_column_custom_minimum_width(index, int((52 if index == 1 else 90) * _scale))
		report.set_column_expand_ratio(index, 2 if index in [0, 4] else 1)
	report.column_titles_visible = true
	report.hide_root = true
	report.custom_minimum_size.y = 64 * _scale
	report.size_flags_vertical = Control.SIZE_EXPAND_FILL
	split.add_child(report)
	status = TextEdit.new()
	status.editable = false
	status.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	status.custom_minimum_size.y = 40 * _scale
	status.size_flags_vertical = Control.SIZE_EXPAND_FILL
	status.placeholder_text = "依赖引用链、验证错误和导出进度显示在这里。"
	split.add_child(status)

func _form_row(parent: Control, title: String) -> HBoxContainer:
	var row := _row(parent)
	_label(row, title).custom_minimum_size.x = 90 * _scale
	return row

func _row(parent: Control) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", int(8 * _scale))
	parent.add_child(row)
	return row

func _line_edit(parent: Control, placeholder: String) -> LineEdit:
	var field := LineEdit.new()
	field.placeholder_text = placeholder
	field.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	field.custom_minimum_size.x = 64 * _scale
	parent.add_child(field)
	return field

func _button(parent: Control, text: String) -> Button:
	var button := Button.new()
	button.text = text
	parent.add_child(button)
	return button

func _label(parent: Control, text: String) -> Label:
	var label := Label.new()
	label.text = text
	parent.add_child(label)
	return label

func _note(parent: Control, text: String) -> void:
	var label := _label(parent, text)
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.modulate.a = 0.75

func select_pack(id: String, count: int, selected_files: int) -> void:
	pack_count.text = "资源包 · %s" % count
	delete_button.disabled = id.is_empty()
	depends.editable = not id.is_empty()
	resource_title.text = "资源文件" if id.is_empty() else "%s · 已选 %s 个文件" % [id, selected_files]
	resource_title.tooltip_text = resource_title.text
	resource_hint.text = "先在资源分包页添加或选择一个包。" if id.is_empty() else "当前资源包：%s。此处只需补充无法自动分析的动态依赖。" % id
	resource_hint.tooltip_text = resource_hint.text

func show_message(message: String, details: String = "", reveal: bool = false, failed: bool = false) -> void:
	notice.text = message
	notice.tooltip_text = message
	if failed:
		notice.add_theme_color_override("font_color", get_theme_color("error_color", "Editor"))
	else:
		notice.remove_theme_color_override("font_color")
	if not details.is_empty():
		status.text = details
	if reveal:
		tabs.current_tab = 2
		summary.text = message
		summary.tooltip_text = message

## 展示最新分析结果并收起上一次导出的进度。
func show_analysis(result: Dictionary) -> void:
	progress_row.visible = false
	report.clear()
	var root := report.create_item()
	for id: String in result.get("order", []):
		var item := report.create_item(root)
		_cells(item, [id, str(result.packs[id].size()), String.humanize_size(result.sizes[id]), "待导出", ", ".join(result.depends[id]) if not result.depends[id].is_empty() else "无"])

func show_export(manifest: Dictionary) -> void:
	report.clear()
	var root := report.create_item()
	for id: String in manifest.packs:
		var pack: Dictionary = manifest.packs[id]
		var item := report.create_item(root)
		_cells(item, [id, str(pack.archive_files.size()), String.humanize_size(pack.pck_size), String.humanize_size(pack.br_size), ", ".join(pack.depends) if not pack.depends.is_empty() else "无"])
		item.set_tooltip_text(3, "压缩后为原始大小的 %.1f%%" % (100.0 * pack.br_size / pack.pck_size))

## 开始新的后台导出，清除上次的进度状态。
func start_export_progress(total: int) -> void:
	progress_row.visible = true
	progress_bar.max_value = maxi(total, 1)
	progress_bar.value = 0
	progress_label.text = "准备导出"
	progress_count.text = "0/%s 步" % total
	show_message("准备导出 · 0/%s 步" % total, "后台导出已启动，期间请勿修改资源。", true)

## 显示工作进程报告的真实步骤进度与当前阶段。
func show_export_progress(done: int, total: int, stage: String) -> void:
	if total <= 0 or done < 0 or done > total:
		return
	progress_row.visible = true
	progress_bar.max_value = total
	progress_bar.value = done
	progress_label.text = stage
	progress_label.tooltip_text = stage
	progress_count.text = "%s/%s 步" % [done, total]
	show_message("%s · %s/%s 步" % [stage, done, total], "当前阶段：%s\n已完成 %s/%s 个导出步骤。" % [stage, done, total], true)

## 保留失败时已完成的步骤；只有成功时将进度置满。
func finish_export_progress(success: bool) -> void:
	if success:
		progress_bar.value = progress_bar.max_value
		progress_count.text = "%s/%s 步" % [int(progress_bar.max_value), int(progress_bar.max_value)]
		progress_label.text = "导出完成"
	else:
		progress_label.text = "导出中断"

func _cells(item: TreeItem, values: Array) -> void:
	for index in values.size():
		item.set_text(index, values[index])
		item.set_tooltip_text(index, values[index])
		item.set_text_overrun_behavior(index, TextServer.OVERRUN_TRIM_ELLIPSIS)

func set_busy(busy: bool) -> void:
	export_button.disabled = busy
	analyze_button.disabled = busy
	export_button.text = "正在导出…" if busy else "导出 .pck.br"
