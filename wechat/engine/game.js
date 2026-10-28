import packConfig from "./pack-config";
import scenePackConfig from "./scene-pack-config";
import { BrotliDecode } from "./vendor/brotli-decode";
import "./remote-pack";
import "./manifest-packs";
import "./godot-sdk";
import "./scene-packs";
import "./godot";
const exe = "/engine/godot";
GameGlobal.scenePacks.configure(scenePackConfig, BrotliDecode);
GameGlobal.GODOTSDK.startGame(exe, packConfig, BrotliDecode).catch((error) => {
    console.error("Godot startup failed. Check the engine, PCK configuration and network.", error);
    if (typeof wx !== "undefined" && wx.showModal) {
        wx.showModal({
            title: "资源加载失败",
            content: String(error.message || error),
            confirmText: "重新启动",
            cancelText: "取消",
            success(result) {
                if (result.confirm && wx.restartMiniProgram) wx.restartMiniProgram({});
            },
        });
    }
});
