extends Node

var _peer := StreamPeerTCP.new()
var _token := ""
var _receive_buffer := ""
var _ready_sent := false
var _signal_waits: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_token = OS.get_environment("GODOT_MCP_PLAYTEST_TOKEN")
	var port := int(OS.get_environment("GODOT_MCP_PLAYTEST_PORT"))
	if _token.is_empty() or port <= 0:
		push_error("Godot MCP playtest bridge is missing its ephemeral connection settings")
		get_tree().quit(2)
		return
	var error := _peer.connect_to_host("127.0.0.1", port)
	if error != OK:
		push_error("Godot MCP playtest bridge could not connect: %s" % error_string(error))
		get_tree().quit(2)


func _process(_delta: float) -> void:
	_peer.poll()
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	if not _ready_sent:
		_ready_sent = true
		_write_message({"type": "ready", "token": _token})
	var available := _peer.get_available_bytes()
	if available <= 0:
		return
	_receive_buffer += _peer.get_utf8_string(available)
	while _receive_buffer.contains("\n"):
		var newline := _receive_buffer.find("\n")
		var line := _receive_buffer.left(newline).strip_edges()
		_receive_buffer = _receive_buffer.substr(newline + 1)
		if not line.is_empty():
			_handle_line(line)


func _handle_line(line: String) -> void:
	var parsed: Variant = JSON.parse_string(line)
	if not parsed is Dictionary:
		return
	var message := parsed as Dictionary
	if message.get("token", "") != _token:
		_peer.disconnect_from_host()
		return
	var request_id := int(message.get("id", 0))
	var command := str(message.get("command", ""))
	match command:
		"input":
			_handle_input(request_id, message.get("event", {}))
		"state":
			_respond(request_id, _runtime_state())
		"capture":
			_capture(request_id)
		"wait_signal":
			_wait_for_signal(request_id, message)
		"quit":
			_respond(request_id, {"quitting": true})
			get_tree().call_deferred("quit")
		_:
			_fail(request_id, "Unsupported playtest command: %s" % command)


func _handle_input(request_id: int, raw_event: Variant) -> void:
	if not raw_event is Dictionary:
		_fail(request_id, "Input event must be an object")
		return
	var event_data := raw_event as Dictionary
	var event_type := str(event_data.get("type", ""))
	var input_event: InputEvent
	match event_type:
		"action":
			var action_event := InputEventAction.new()
			action_event.action = StringName(str(event_data.get("action", "")))
			action_event.pressed = bool(event_data.get("pressed", false))
			action_event.strength = float(event_data.get("strength", 1.0))
			input_event = action_event
		"key":
			var key_event := InputEventKey.new()
			key_event.keycode = int(event_data.get("keycode", 0)) as Key
			key_event.pressed = bool(event_data.get("pressed", false))
			key_event.echo = false
			input_event = key_event
		"mouse_motion":
			var motion_event := InputEventMouseMotion.new()
			motion_event.position = Vector2(float(event_data.get("x", 0.0)), float(event_data.get("y", 0.0)))
			motion_event.global_position = motion_event.position
			motion_event.relative = Vector2(float(event_data.get("relativeX", 0.0)), float(event_data.get("relativeY", 0.0)))
			input_event = motion_event
		"mouse_button":
			var button_event := InputEventMouseButton.new()
			button_event.button_index = int(event_data.get("button", 1)) as MouseButton
			button_event.position = Vector2(float(event_data.get("x", 0.0)), float(event_data.get("y", 0.0)))
			button_event.global_position = button_event.position
			button_event.pressed = bool(event_data.get("pressed", false))
			input_event = button_event
		"joypad_button":
			var joy_button_event := InputEventJoypadButton.new()
			joy_button_event.device = int(event_data.get("device", 0))
			joy_button_event.button_index = int(event_data.get("button", 0)) as JoyButton
			joy_button_event.pressed = bool(event_data.get("pressed", false))
			joy_button_event.pressure = float(event_data.get("pressure", 1.0))
			input_event = joy_button_event
		"joypad_motion":
			var joy_motion_event := InputEventJoypadMotion.new()
			joy_motion_event.device = int(event_data.get("device", 0))
			joy_motion_event.axis = int(event_data.get("axis", 0)) as JoyAxis
			joy_motion_event.axis_value = clampf(float(event_data.get("value", 0.0)), -1.0, 1.0)
			input_event = joy_motion_event
		_:
			_fail(request_id, "Unsupported input event type: %s" % event_type)
			return
	Input.parse_input_event(input_event)
	_respond(request_id, {"accepted": true, "type": event_type})


func _runtime_state() -> Dictionary:
	var current_scene := get_tree().current_scene
	var viewport := get_viewport()
	var focus_owner := viewport.gui_get_focus_owner()
	return {
		"currentScenePath": str(current_scene.scene_file_path) if current_scene != null else "",
		"currentSceneNodePath": str(current_scene.get_path()) if current_scene != null else "",
		"focusedControlPath": str(focus_owner.get_path()) if focus_owner != null else "",
		"viewportSize": {"x": viewport.get_visible_rect().size.x, "y": viewport.get_visible_rect().size.y},
		"mousePosition": {"x": viewport.get_mouse_position().x, "y": viewport.get_mouse_position().y},
		"paused": get_tree().paused,
		"frame": Engine.get_process_frames(),
	}


func _capture(request_id: int) -> void:
	# frame_post_draw is not emitted by every headless renderer. One process
	# frame is sufficient because this autoload runs after the composed scene.
	await get_tree().process_frame
	var image := get_viewport().get_texture().get_image()
	if image == null or image.is_empty():
		_fail(request_id, "Viewport capture returned an empty image")
		return
	var path := "res://.godot/mcp-playtest/capture-%s-%s.png" % [_token, request_id]
	var error := image.save_png(path)
	if error != OK:
		_fail(request_id, "Could not save viewport capture: %s" % error_string(error))
		return
	_respond(request_id, {"path": ProjectSettings.globalize_path(path)})


func _wait_for_signal(request_id: int, message: Dictionary) -> void:
	var node_path := NodePath(str(message.get("nodePath", "")))
	var signal_name := StringName(str(message.get("signal", "")))
	var target := get_node_or_null(node_path)
	if target == null:
		_fail(request_id, "Signal node was not found: %s" % node_path)
		return
	if not target.has_signal(signal_name):
		_fail(request_id, "Node does not expose signal: %s" % signal_name)
		return
	for signal_info in target.get_signal_list():
		if StringName(signal_info.get("name", "")) == signal_name and not signal_info.get("args", []).is_empty():
			_fail(request_id, "wait_for_signal currently accepts zero-argument signals only")
			return
	var callback := Callable(self, "_signal_received").bind(request_id)
	var error := target.connect(signal_name, callback, CONNECT_ONE_SHOT)
	if error != OK:
		_fail(request_id, "Could not connect signal: %s" % error_string(error))
		return
	_signal_waits[request_id] = {"target": target, "signal": signal_name, "callback": callback}
	var timeout_seconds := float(message.get("timeoutMs", 5000)) / 1000.0
	get_tree().create_timer(timeout_seconds, true, false, true).timeout.connect(_signal_timeout.bind(request_id), CONNECT_ONE_SHOT)


func _signal_received(request_id: int) -> void:
	if not _signal_waits.erase(request_id):
		return
	_respond(request_id, {"emitted": true})


func _signal_timeout(request_id: int) -> void:
	if not _signal_waits.has(request_id):
		return
	var wait: Dictionary = _signal_waits[request_id]
	_signal_waits.erase(request_id)
	var target: Object = wait["target"]
	var signal_name: StringName = wait["signal"]
	var callback: Callable = wait["callback"]
	if is_instance_valid(target) and target.is_connected(signal_name, callback):
		target.disconnect(signal_name, callback)
	_fail(request_id, "Signal wait timed out")


func _respond(request_id: int, result: Variant) -> void:
	_write_message({"id": request_id, "token": _token, "ok": true, "result": result})


func _fail(request_id: int, message: String) -> void:
	_write_message({"id": request_id, "token": _token, "ok": false, "error": message})


func _write_message(message: Dictionary) -> void:
	if _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_peer.put_data((JSON.stringify(message) + "\n").to_utf8_buffer())
