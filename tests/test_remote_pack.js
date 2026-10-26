"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const engineDir = path.join(__dirname, "../wechat/engine");
const decoderSource = fs.readFileSync(path.join(engineDir, "vendor/brotli-decode.js"), "utf8")
    .replace("export let BrotliDecode = makeBrotliDecode();", "globalThis.BrotliDecode = makeBrotliDecode();");

function pck(content) {
    const header = Buffer.alloc(20);
    header.write("GDPC", 0, "ascii");
    header.writeUInt32LE(4, 4);
    header.writeUInt32LE(4, 8);
    header.writeUInt32LE(7, 12);
    header.writeUInt32LE(2, 16);
    return Buffer.concat([header, Buffer.from(content)]);
}

function config(name, raw) {
    const compressed = zlib.brotliCompressSync(raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
    return {
        compressed,
        settings: {
            schema: 1, mode: "remote", url: `https://example.com/${name}.pck.br`,
            path: "/engine/demo-pck.bin", br_sha256: digest(compressed), br_size: compressed.length,
            pck_sha256: digest(raw), pck_size: raw.length, engine_version: "4.7.2",
        },
    };
}

function harness() {
    const files = new Map();
    const network = new Map();
    const preloads = [];
    const progress = [];
    let downloads = 0;
    let cleaned = 0;
    let failedPckHash = null;
    const fileSystem = {
        readFile({ filePath, encoding, success, fail }) {
            if (!files.has(filePath)) return fail({ errMsg: "file missing: " + filePath });
            const value = files.get(filePath);
            success({ data: encoding ? value.toString(encoding) : Buffer.from(value) });
        },
        copyFile({ srcPath, destPath, success, fail }) {
            if (!files.has(srcPath)) return fail({ errMsg: "source missing" });
            files.set(destPath, Buffer.from(files.get(srcPath)));
            success({});
        },
        writeFile({ filePath, data, success }) {
            files.set(filePath, Buffer.from(data));
            success({});
        },
        unlink({ filePath, success, fail }) {
            if (!files.delete(filePath)) return fail({ errMsg: "file missing" });
            success({});
        },
    };
    const loader = {
        config: { textConfig: { compilingText: "compile", completeText: "done" } },
        updateProgress(value, label) { progress.push([value, label]); },
        cleanup() { cleaned++; },
        render() {},
    };
    const context = {
        console: { log: console.log, warn() {}, error: console.error },
        Buffer, GameGlobal: { godotLoader: loader }, canvas: {},
        wx: {
            env: { USER_DATA_PATH: "/user" },
            getFileSystemManager: () => fileSystem,
            downloadFile({ url, success, fail }) {
                downloads++;
                const entry = network.get(url);
                return {
                    onProgressUpdate(handler) {
                        setImmediate(() => {
                            handler({ progress: 80 });
                            if (!entry || entry.error) return fail({ errMsg: entry ? entry.error : "offline" });
                            const tempFilePath = `/temp/${downloads}`;
                            files.set(tempFilePath, Buffer.from(entry.data));
                            success({ statusCode: entry.statusCode || 200, tempFilePath });
                        });
                    },
                };
            },
        },
        Engine: class {
            static isWebGLAvailable() { return true; }
            init() { return Promise.resolve(); }
            preloadFile(bytes, virtualPath) {
                assert.equal(virtualPath, "/engine/demo-pck.bin");
                assert.equal(Object.prototype.toString.call(bytes), "[object ArrayBuffer]");
                this.bytes = Buffer.from(bytes);
                preloads.push(this.bytes);
                return Promise.resolve();
            }
            start() {
                const digest = crypto.createHash("sha256").update(this.bytes).digest("hex");
                return digest === failedPckHash ? Promise.reject(new Error("start failed")) : Promise.resolve();
            }
        },
    };
    vm.createContext(context);
    vm.runInContext(decoderSource, context);
    vm.runInContext(fs.readFileSync(path.join(engineDir, "remote-pack.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(engineDir, "godot-sdk.js"), "utf8"), context);
    const start = (settings) => context.GameGlobal.GODOTSDK.startGame("/engine/godot", settings, context.BrotliDecode);
    return {
        files, network, preloads, progress, start, loader,
        get downloads() { return downloads; },
        get cleaned() { return cleaned; },
        failStart(raw) { failedPckHash = crypto.createHash("sha256").update(raw).digest("hex"); },
        runtime: context.GameGlobal.remotePack,
    };
}

async function test() {
    const h = harness();
    assert.equal(h.runtime.sha256(Buffer.from("abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const data of [Buffer.alloc(0), Buffer.alloc(1024 * 1024, 0xa5)]) {
        assert.equal(h.runtime.sha256(data), crypto.createHash("sha256").update(data).digest("hex"));
    }
    const a = config("a", pck("first version"));
    const b = config("b", pck("second version"));
    h.network.set(a.settings.url, { data: a.compressed });
    await h.start(a.settings);
    assert.equal(h.downloads, 1);
    assert.deepEqual(h.preloads[0], pck("first version"));
    assert.equal(JSON.parse(h.files.get("/user/godot-pck-last-good.json")).config.br_sha256, a.settings.br_sha256);
    assert(h.progress.some(([value]) => value > 0.5 && value < 0.92), "download progress was not shown");

    await h.start(a.settings);
    assert.equal(h.downloads, 1, "current cache should skip the network");

    await h.start(b.settings);
    assert.equal(h.downloads, 2);
    assert.deepEqual(h.preloads.at(-1), pck("first version"), "offline update should use last good PCK");

    h.network.set(b.settings.url, { data: Buffer.from("corrupt") });
    await h.start(b.settings);
    assert.deepEqual(h.preloads.at(-1), pck("first version"), "corrupt download should use last good PCK");

    h.network.set(b.settings.url, { data: b.compressed });
    h.failStart(pck("second version"));
    await h.start(b.settings);
    assert.deepEqual(h.preloads.at(-1), pck("first version"), "failed start should retry the old PCK");
    assert.equal(JSON.parse(h.files.get("/user/godot-pck-last-good.json")).config.br_sha256, a.settings.br_sha256);

    h.failStart(Buffer.alloc(0));
    await h.start(b.settings);
    assert.deepEqual(h.preloads.at(-1), pck("second version"));
    assert.equal(JSON.parse(h.files.get("/user/godot-pck-last-good.json")).config.br_sha256, b.settings.br_sha256);
    assert(!h.files.has("/user/godot-pck-" + a.settings.br_sha256 + ".br"), "old cache should be pruned");
    assert.equal(h.cleaned, 6);

    const cachedB = "/user/godot-pck-" + b.settings.br_sha256 + ".br";
    h.files.set(cachedB, Buffer.from("corrupt cache"));
    await h.start(b.settings);
    assert.equal(h.downloads, 6, "corrupt current cache should trigger a fresh download");
    assert.deepEqual(h.preloads.at(-1), pck("second version"));

    const firstOffline = harness();
    await assert.rejects(firstOffline.start(a.settings), /offline/);
    assert.equal(firstOffline.loader.currentText, "游戏资源加载失败，请检查网络或控制台");
    firstOffline.network.set(a.settings.url, { data: a.compressed, statusCode: 404 });
    await assert.rejects(firstOffline.start(a.settings), /HTTP 404/);
    await assert.rejects(firstOffline.start({ ...a.settings, br_sha256: "bad" }), /Invalid remote PCK config/);

    const bundled = harness();
    const bundledConfig = { ...a.settings, mode: "bundled_br", file: "engine/demo-pck.br" };
    delete bundledConfig.url;
    bundled.files.set(bundledConfig.file, a.compressed);
    await bundled.start(bundledConfig);
    assert.deepEqual(bundled.preloads[0], pck("first version"));
    assert.equal(bundled.downloads, 0, "bundled PCK must not use the network");
    bundled.files.set(bundledConfig.file, Buffer.from("corrupt"));
    await assert.rejects(bundled.start(bundledConfig), /Brotli PCK size or SHA-256 mismatch/);
}

test().then(() => console.log("Remote and bundled Brotli PCK tests passed"))
    .catch((error) => { console.error(error); process.exitCode = 1; });
