"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

function validateRuntime(directory) {
    const root = path.resolve(directory);
    for (const file of ["game.js", "game.json", "project.config.json", "weapp-adapter.js",
        "godot-loader.js", "native-audio-config.js", "native-audio-manifest.js",
        "images/background.jpg", "images/logo.png", "build-info.json", "BUILD_STATUS.txt",
        "engine/game.js", "engine/godot-sdk.js", "engine/godot.js", "engine/godot.wasm.br"]) {
        assert(fs.statSync(path.join(root, file)).size > 0, `Missing/empty ${file}`);
    }
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
    const build = JSON.parse(read("build-info.json"));
    if (build.has_pck) {
        assert(fs.statSync(path.join(root, "engine/demo-pck.bin")).size > 0, "Missing/empty game resource pack");
    } else {
        assert(read("BUILD_STATUS.txt").includes("INCOMPLETE TEMPLATE"), "Missing incomplete-template notice");
    }
    const loader = read("godot-loader.js");
    assert(loader.includes('"webgl2"') && !/wxwebgl|WXGLX|EmscriptenGLX/.test(loader), "Only standard WebGL2 is supported");
    for (const token of ["getWindowInfo", "__godotMinigamePixelRatio", "normalizeProgress", "this.gl.commit"]) {
        assert(loader.includes(token), `Loader missing ${token}`);
    }
    assert(read("engine/godot-sdk.js").includes("root.fsUtils = fsUtils"), "SDK must be the readable paired runtime");
    const engine = read("engine/godot.js");
    for (const token of ["WXMEMFS", "nowPolyfill", "wx.exitMiniProgram", "wasm.br", "godot_audio_sample_register_native_stream"]) {
        assert(engine.includes(token), `Engine missing ${token}`);
    }
    assert(!engine.includes("FS.mount(IDBFS"), "Unpatched file system");
    assert(!/var\s+_emscripten_webgl_commit_frame\s*=\s*function\s*\(\s*\)\s*\{\s*\}/.test(engine), "Frame commit must not be a no-op");
    if (engine.includes("_emscripten_webgl_do_commit_frame")) {
        assert(engine.includes("__godotMinigameOriginalCommitFrame"), "Missing frame commit wrapper");
    }
    const config = JSON.parse(read("game.json"));
    assert(config.subpackages.some((p) => p.name === "engine" && p.root === "engine/"));
    const entry = read("engine/game.js");
    assert(entry.includes("'/engine/demo-pck.bin'"), "Unexpected game resource path");
    const sdkIndex = entry.indexOf("import './godot-sdk'");
    assert(sdkIndex >= 0 && sdkIndex < entry.indexOf("import './godot'"), "SDK must load before the engine");
    const start = read("game.js");
    const imports = ["native-audio-config", "native-audio-manifest", "weapp-adapter", "godot-loader"];
    const positions = imports.map((name) => start.indexOf(`import './${name}'`));
    assert(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), "Invalid host startup order");
    return root;
}
module.exports = { validateRuntime };
if (require.main === module) {
    try {
        if (!process.argv[2]) throw new Error("Usage: node tools/validate_runtime.js <host-directory>");
        console.log(`Validated standard WebGL2 runtime: ${validateRuntime(process.argv[2])}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
