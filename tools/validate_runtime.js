"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

function validateRuntime(directory) {
    const root = path.resolve(directory);
    for (const file of ["game.js", "game.json", "project.config.json", "weapp-adapter.js",
        "godot-loader.js", "native-audio-config.js", "native-audio-manifest.js",
        "images/background.jpg", "images/logo.png", "build-info.json", "BUILD_STATUS.txt",
        "engine/game.js", "engine/godot-sdk.js", "engine/remote-pack.js", "engine/pack-config.js",
        "engine/scene-packs.js", "engine/scene-pack-config.js",
        "engine/vendor/brotli-decode.js", "engine/vendor/BROTLI-LICENSE.txt",
        "engine/godot.js", "engine/godot.wasm.br"]) {
        assert(fs.statSync(path.join(root, file)).size > 0, `Missing/empty ${file}`);
    }
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
    const build = JSON.parse(read("build-info.json"));
    const packSource = read("engine/pack-config.js");
    const packMatch = /^\s*export default ([\s\S]*);\s*$/.exec(packSource);
    assert(packMatch, "Invalid pack config module");
    const pack = JSON.parse(packMatch[1]);
    if (build.pack_mode === "remote") {
        assert(pack.mode === "remote" && pack.schema === 1, "Missing remote PCK config");
        assert(/^https:\/\/[^?#]+\.pck\.br$/.test(pack.url), "Invalid remote PCK URL");
        assert(pack.path === "/engine/demo-pck.bin", "Invalid virtual PCK path");
        assert(/^[0-9a-f]{64}$/.test(pack.br_sha256) && /^[0-9a-f]{64}$/.test(pack.pck_sha256),
            "Invalid remote PCK SHA-256");
        assert(Number.isSafeInteger(pack.br_size) && pack.br_size > 0 &&
            Number.isSafeInteger(pack.pck_size) && pack.pck_size > 0, "Invalid remote PCK size");
        assert(/^\d+\.\d+\.\d+$/.test(pack.engine_version), "Invalid remote PCK engine version");
        assert(read("BUILD_STATUS.txt").includes("REMOTE PCK TEMPLATE"), "Missing remote-template notice");
    } else if (build.pack_mode === "bundled_br") {
        assert(build.has_pck && pack.mode === "bundled_br" && pack.schema === 1, "Missing bundled PCK config");
        assert(pack.path === "/engine/demo-pck.bin" && pack.file === "engine/demo-pck.br", "Invalid bundled PCK paths");
        assert(/^[0-9a-f]{64}$/.test(pack.br_sha256) && /^[0-9a-f]{64}$/.test(pack.pck_sha256),
            "Invalid bundled PCK hashes");
        assert(Number.isSafeInteger(pack.br_size) && pack.br_size > 0 &&
            Number.isSafeInteger(pack.pck_size) && pack.pck_size > 0, "Invalid bundled PCK sizes");
        const compressed = fs.readFileSync(path.join(root, pack.file));
        const crypto = require("crypto");
        assert(compressed.length === pack.br_size &&
            crypto.createHash("sha256").update(compressed).digest("hex") === pack.br_sha256,
            "Bundled Brotli PCK changed");
        assert(read("BUILD_STATUS.txt").includes("BUNDLED BROTLI PCK"), "Missing bundled-PCK notice");
    } else if (build.has_pck) {
        assert(fs.statSync(path.join(root, "engine/demo-pck.bin")).size > 0, "Missing/empty game resource pack");
    } else {
        assert(pack.mode === "local" && pack.path === "/engine/demo-pck.bin", "Invalid local PCK config");
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
    if (build.scene_packs) {
        const sceneMatch = /^\s*export default ([\s\S]*);\s*$/.exec(read("engine/scene-pack-config.js"));
        assert(sceneMatch, "Invalid scene pack config module");
        const scene = JSON.parse(sceneMatch[1]);
        assert(scene.schema === 1 && scene.engine_version === pack.engine_version, "Invalid scene pack version");
        assert(scene.scene_to_group[scene.entry_scene], "Missing entry scene group");
        for (const [id, item] of Object.entries(scene.packs)) {
            if (item.mode === "local") {
                assert(config.subpackages.some((p) => p.name === item.subpackage && p.root === `packs/${id}/`),
                    `Missing scene subpackage ${id}`);
                assert(fs.statSync(path.join(root, item.file)).size === item.br_size, `Invalid scene pack ${id}`);
            }
        }
    }
    const entry = read("engine/game.js");
    assert(entry.includes("import packConfig from './pack-config'"), "Entry must load PCK config");
    assert(entry.includes("import './remote-pack'"), "Entry must load remote PCK runtime");
    assert(entry.includes("import './scene-packs'"), "Entry must load scene pack runtime");
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
