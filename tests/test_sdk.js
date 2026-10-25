"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

async function test() {
    const events = [];
    let hide, show;
    const context = {
        console, GameGlobal: {}, canvas: {},
        wx: {
            createWebAudioContext: () => ({ suspend() { events.push("suspend"); }, resume() { events.push("resume"); } }),
            onHide(fn) { hide = fn; }, onShow(fn) { show = fn; },
            getFileSystemManager: () => ({ readFile({ filePath, success }) { success({ data: new Uint8Array([1, 2]).buffer }); } }),
        },
        Engine: class {
            static isWebGLAvailable() { return true; }
            init() { events.push("init"); return Promise.resolve(); }
            preloadFile(file) { events.push(file); return Promise.resolve(); }
            start(options) { events.push(options.args.join(" ")); return Promise.resolve(); }
        },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../wechat/engine/godot-sdk.js"), "utf8"), context);
    assert(context.GameGlobal.GODOTSDK.audio.WEBAudio.audioContext);
    assert.equal((await context.fsUtils.localFetch("engine/demo-pck.bin")).byteLength, 2);
    await context.GameGlobal.GODOTSDK.startGame("/engine/godot", "/engine/demo-pck.bin");
    assert.deepEqual(events, ["init", "/engine/demo-pck.bin", "--main-pack /engine/demo-pck.bin"]);
    hide(); show();
    assert.deepEqual(events.slice(-2), ["suspend", "resume"]);
    delete context.Engine;
    await assert.rejects(context.GameGlobal.GODOTSDK.startGame("engine", "pack"), /Engine is not available/);
}
test().then(() => console.log("SDK startup, resource and audio lifecycle tests passed")).catch((error) => { console.error(error); process.exitCode = 1; });
