
import './godot-sdk'
import './godot'
const exe = '/engine/godot';
const pack = '/engine/demo-pck.bin';
GameGlobal.GODOTSDK.startGame(exe, pack).catch((error) => {
    console.error('Godot startup failed. Check the matching engine pair and engine/demo-pck.bin.', error);
});
