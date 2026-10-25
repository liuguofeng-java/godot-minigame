extends Control

const SAVE_PATH := "user://smoke-count.txt"
var count := 0
var status: Label
var player: AudioStreamPlayer

func _ready() -> void:
	if FileAccess.file_exists(SAVE_PATH):
		count = FileAccess.get_file_as_string(SAVE_PATH).to_int()
	var layout := VBoxContainer.new()
	layout.position = Vector2(24, 40)
	layout.size.x = 490
	layout.add_theme_constant_override("separation", 16)
	add_child(layout)
	status = Label.new()
	status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	layout.add_child(status)
	add_button(layout, "Save and read counter", save_counter)
	add_button(layout, "Play short tone (WebAudio)", func(): play_tone(0.3))
	add_button(layout, "Play long tone (native audio)", func(): play_tone(4.0))
	add_button(layout, "Stop audio", func(): player.stop())
	player = AudioStreamPlayer.new()
	player.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
	add_child(player)
	status.text = "Saved count: %d\nRestart the game to check persistence." % count

func add_button(layout: VBoxContainer, caption: String, action: Callable) -> void:
	var button := Button.new()
	button.text = caption
	button.custom_minimum_size.y = 56
	button.pressed.connect(action)
	layout.add_child(button)

func save_counter() -> void:
	var file := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if file == null:
		status.text = "Cannot open save file: %s" % FileAccess.get_open_error()
		return
	count += 1
	file.store_string(str(count))
	file.close()
	status.text = "Saved count: %d\nRead back: %s" % [count, FileAccess.get_file_as_string(SAVE_PATH)]

func play_tone(seconds: float) -> void:
	player.stop()
	var rate := 22050
	var frames := int(rate * seconds)
	var data := PackedByteArray()
	data.resize(frames * 2)
	for i in range(frames):
		data.encode_s16(i * 2, int(sin(TAU * 440.0 * i / rate) * 4000.0))
	var tone := AudioStreamWAV.new()
	tone.format = AudioStreamWAV.FORMAT_16_BITS
	tone.mix_rate = rate
	tone.data = data
	player.stream = tone
	player.play()
	status.text = "Playing %.1f seconds. Try stop, replay, and switching apps." % seconds
