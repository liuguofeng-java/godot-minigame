
import packConfig from './pack-config'
import scenePackConfig from './scene-pack-config'
import { BrotliDecode } from './vendor/brotli-decode'
import './remote-pack'
import './godot-sdk'
import './scene-packs'
import './godot'
const exe = '/engine/godot';
GameGlobal.scenePacks.configure(scenePackConfig, BrotliDecode);
GameGlobal.GODOTSDK.startGame(exe, packConfig, BrotliDecode).catch((error) => {
    console.error('Godot startup failed. Check the engine, PCK configuration and network.', error);
});
