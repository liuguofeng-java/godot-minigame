## 可替换的加载界面；只显示状态并发出按钮意图，不下载资源或切换场景。
extends CanvasLayer

signal retry_requested
signal rollback_requested
@onready var _retry_button: Button = %Retry
@onready var _rollback_button: Button = %Rollback
@onready var _detail: Label = %Detail
@onready var _status: Label = %Status
@onready var _percent: Label = %Percent
@onready var _content: Control = %Content
@onready var _mark: Control = %Mark
@onready var _track: ColorRect = %Track
@onready var _fill: ColorRect = %Fill
var _motion := 0.0
var _known_total := false
var _fraction := 0.0


func _ready() -> void:
	_retry_button.pressed.connect(func() -> void: retry_requested.emit())
	_rollback_button.pressed.connect(func() -> void: rollback_requested.emit())
	get_viewport().size_changed.connect(_layout)
	_layout()


func set_active(active: bool) -> void:
	visible = active


func reset_actions() -> void:
	_retry_button.hide()
	_rollback_button.hide()
	_layout()


func show_progress(text: String, completed: float, total: float, detail: String = "") -> void:
	_track.show()
	_status.text = text
	_detail.text = detail
	_known_total = total > 0
	_fraction = clampf(completed / total, 0.0, 1.0) if _known_total else 0.0
	_percent.text = "%s%%" % int(_fraction * 100.0) if _known_total else ""
	_bar()


func show_error(message: String, retryable: bool, can_rollback: bool) -> void:
	_known_total = false
	_track.hide()
	_percent.text = ""
	_status.text = "加载未完成"
	_detail.text = message
	_retry_button.visible = retryable
	_retry_button.disabled = false
	_rollback_button.visible = can_rollback
	_rollback_button.disabled = false
	_layout()


func show_rollback_check() -> void:
	_rollback_button.disabled = true
	_retry_button.disabled = true
	_detail.text = "正在检查上次成功的资源…"


func _process(delta: float) -> void:
	if not visible:
		return
	_motion += delta
	for index in 4:
		var tile: Control = _mark.get_child(index)
		tile.position.y = (
			floorf(float(index) / 2.0) * 30.0 - maxf(0.0, sin(_motion * 2.0 - index * 0.6)) * 5.0
		)
	_bar()


## 按视口和按钮状态居中；窄屏缩小内容，不依赖原场景的 owner 查找控件。
func _layout() -> void:
	var viewport := get_viewport().get_visible_rect().size
	var content: Control = _content
	var height := 330.0 if _retry_button.visible or _rollback_button.visible else 228.0
	content.size = Vector2(minf(360.0, maxf(1.0, viewport.x - 48.0)), height)
	content.scale = Vector2.ONE * minf(1.0, maxf(1.0, viewport.y - 32.0) / height)
	content.position = (viewport - content.size * content.scale) * 0.5
	_mark.position.x = content.size.x * 0.5 - 28.0
	_bar()


func _bar() -> void:
	var width: float = _track.size.x
	_fill.size.x = width * (_fraction if _known_total else 0.22)
	_fill.position.x = 0.0 if _known_total else width * 0.78 * (sin(_motion * 1.6) + 1.0) * 0.5
