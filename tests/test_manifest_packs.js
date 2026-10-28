"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object")
        return (
            "{" +
            Object.keys(v)
                .sort()
                .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
                .join(",") +
            "}"
        );
    return JSON.stringify(v);
}
function release(version = "one", patch = 2) {
    const manifest = {
        schema: 2,
        project_id: "测试项目",
        engine_version: `4.7.${patch}`,
        bootstrap: "bootstrap",
        entry_scene: "res://a/A.tscn",
        scene_to_pack: { "res://a/A.tscn": "a" },
        packs: {},
    };
    const files = new Map();
    for (const id of ["bootstrap", "a", "b", "c", "x"]) {
        const header = Buffer.alloc(20);
        header.write("GDPC");
        [4, 4, 7, patch].forEach((v, i) => header.writeUInt32LE(v, 4 + i * 4));
        const pck = Buffer.concat([header, Buffer.from(id + (id === "b" ? version : "stable"))]);
        const br = zlib.brotliCompressSync(pck);
        const url = `packs/${id}-${hash(br)}.pck.br`;
        manifest.packs[id] = {
            url,
            compression: "br",
            br_size: br.length,
            br_sha256: hash(br),
            pck_size: pck.length,
            pck_sha256: hash(pck),
            depends: id === "a" ? ["b"] : id === "b" ? ["c"] : [],
            files: id === "a" ? ["res://a/A.tscn"] : [],
        };
        files.set("https://cdn.example/game/" + url, br);
    }
    seal(manifest);
    return { manifest, files };
}
function seal(m) {
    delete m.release_id;
    m.release_id = hash(canonical(m));
}
function harness(saved = new Map()) {
    const h = {
        saved,
        network: new Map(),
        downloads: [],
        manifest: null,
        offline: false,
        badRename: false,
        active: 0,
        maximum: 0,
    };
    const failure = (fail, message) => fail({ errMsg: message });
    const filesystem = {
        mkdir({ success }) {
            success({});
        },
        readFile({ filePath, encoding, success, fail }) {
            if (!saved.has(filePath)) return failure(fail, "ENOENT");
            const bytes = Buffer.from(saved.get(filePath));
            success({ data: encoding ? bytes.toString() : bytes });
        },
        writeFile({ filePath, data, success }) {
            saved.set(filePath, Buffer.from(data));
            success({});
        },
        copyFile({ srcPath, destPath, success, fail }) {
            if (!saved.has(srcPath)) return failure(fail, "ENOENT");
            saved.set(destPath, Buffer.from(saved.get(srcPath)));
            success({});
        },
        rename({ oldPath, newPath, success, fail }) {
            if (h.badRename && newPath.endsWith("successful.json"))
                return failure(fail, "disk failure");
            if (!saved.has(oldPath)) return failure(fail, "ENOENT");
            saved.set(newPath, saved.get(oldPath));
            saved.delete(oldPath);
            success({});
        },
        unlink({ filePath, success }) {
            saved.delete(filePath);
            success({});
        },
        readdir({ dirPath, success }) {
            success({
                files: [...saved.keys()]
                    .filter((k) => k.startsWith(dirPath + "/"))
                    .map((k) => k.slice(dirPath.length + 1)),
            });
        },
    };
    const context = {
        console: { log() {}, warn() {}, error: console.error },
        setTimeout,
        clearTimeout,
        GameGlobal: {},
        wx: {
            env: { USER_DATA_PATH: "/user" },
            getFileSystemManager: () => filesystem,
            request({ success, fail }) {
                if (h.offline) return failure(fail, "offline");
                success({ statusCode: 200, data: JSON.stringify(h.manifest) });
            },
            downloadFile({ url, success, fail }) {
                h.downloads.push(url);
                h.active++;
                h.maximum = Math.max(h.maximum, h.active);
                const name = "/temp/" + h.downloads.length;
                setTimeout(() => {
                    h.active--;
                    if (!h.network.has(url)) return failure(fail, "offline");
                    saved.set(name, h.network.get(url));
                    success({ statusCode: 200, tempFilePath: name });
                }, 2);
                return {
                    onProgressUpdate(callback) {
                        callback({ progress: 50 });
                    },
                };
            },
        },
    };
    vm.createContext(context);
    for (const file of ["remote-pack.js", "manifest-packs.js"]) {
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, "../wechat/engine", file), "utf8"),
            context
        );
    }
    h.api = context.GameGlobal.manifestPacks;
    h.context = context;
    h.decoder = (bytes) =>
        zlib.brotliDecompressSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    h.prepare = (scene) =>
        h.api.prepare(
            {
                mode: "manifest",
                manifest_url: "https://cdn.example/game/manifest.json",
                engine_version: "4.7.2",
                scene,
            },
            h.decoder
        );
    h.use = (r) => {
        h.manifest = r.manifest;
        h.network = r.files;
    };
    return h;
}
async function tests() {
    await catalogTests();
    const lan = harness(),
        localRelease = release("lan", 0);
    lan.use(localRelease);
    lan.network = new Map(
        [...localRelease.files].map(([url, bytes]) => [
            url.replace("https://cdn.example/game/", "http://10.198.46.142:9000/"),
            bytes,
        ])
    );
    const localConfig = {
        mode: "manifest",
        manifest_url: "http://10.198.46.142:9000/manifest.json",
        engine_version: "4.7.2",
    };
    await assert.rejects(
        lan.api.prepare(localConfig, lan.decoder),
        /Invalid manifest startup config/
    );
    const localSession = await lan.api.prepare({ ...localConfig, local_dev: true }, lan.decoder);
    assert.equal(localSession.manifest.engine_version, "4.7.0");
    assert.equal(lan.downloads.length, 4);
    assert.throws(() => lan.api.validate(localRelease.manifest, "4.7.2"), /version/);
    assert.throws(() => lan.api.validate(localRelease.manifest, "4.8.2", true), /version/);
    await assert.rejects(
        lan.api.prepare(
            { ...localConfig, local_dev: true, manifest_url: "http://cdn.example/manifest.json" },
            lan.decoder
        ),
        /Invalid manifest startup config/
    );
    const standalone = release();
    standalone.manifest.entry_scene = "res://x/X.tscn";
    standalone.manifest.scene_to_pack["res://x/X.tscn"] = "x";
    standalone.manifest.packs.x.files = ["res://x/X.tscn"];
    seal(standalone.manifest);
    const onlyX = harness();
    onlyX.use(standalone);
    const xSession = await onlyX.prepare();
    assert.deepEqual(Array.from(xSession.ids), ["bootstrap", "x"]);
    assert.equal(
        onlyX.downloads.length,
        2,
        "X without dependencies loads only X and project startup data"
    );
    const h = harness(),
        first = release();
    h.use(first);
    const session = await h.prepare();
    assert.equal(h.downloads.length, 4);
    assert(h.maximum <= 3);
    assert(!h.downloads.some((url) => url.includes("/x-")), "Unreferenced packs must not download");
    const copied = new Map();
    const installed = await h.api.install(session, h.decoder, (p, b) => copied.set(p, b));
    assert.equal(installed.main, "/scene-packs/bootstrap.pck");
    assert.deepEqual(Array.from(installed.extra), [
        "/scene-packs/c.pck",
        "/scene-packs/b.pck",
        "/scene-packs/a.pck",
    ]);
    assert.equal(copied.size, 4);
    assert(
        ![...h.saved.keys()].some((k) => k.endsWith(".pck")),
        "Disk cache must contain compressed bytes only"
    );
    assert(
        ![...h.saved.keys()].some((k) => k.endsWith("successful.json")),
        "Prepare must not commit"
    );
    await h.api.commit(session);
    const pointer = [...h.saved.keys()].find((k) => k.endsWith("successful.json"));
    const oldPointer = Buffer.from(h.saved.get(pointer));
    const second = release("two");
    h.use(second);
    const next = await h.prepare();
    assert.equal(h.downloads.length, 5, "Only B should download after B changes");
    assert(
        [...h.saved.keys()].some((k) => k.includes(first.manifest.packs.b.br_sha256)),
        "Old B must remain before commit"
    );
    h.badRename = true;
    await assert.rejects(h.api.commit(next), /disk failure/);
    assert.deepEqual(
        h.saved.get(pointer),
        oldPointer,
        "Commit failure preserves last successful release"
    );
    h.badRename = false;
    await h.api.commit(next);
    assert(
        ![...h.saved.keys()].some((k) => k.includes(first.manifest.packs.b.br_sha256)),
        "Obsolete B should be reclaimed"
    );
    h.offline = true;
    assert.equal((await h.prepare()).manifest.release_id, second.manifest.release_id);
    h.offline = false;
    h.use(release("three"));
    h.network.clear();
    assert.equal(
        (await h.prepare()).manifest.release_id,
        second.manifest.release_id,
        "Fallback is an entire release"
    );
    const bCache = [...h.saved.keys()].find((k) => k.includes(second.manifest.packs.b.br_sha256));
    h.saved.set(bCache, Buffer.from("broken"));
    h.offline = true;
    await assert.rejects(h.prepare(), /cached pack unavailable/);
    h.offline = false;
    h.use(second);
    assert.equal(
        (await h.prepare()).manifest.release_id,
        second.manifest.release_id,
        "Corrupt cache is redownloaded"
    );
    const broken = release();
    broken.manifest.packs.c.depends = ["a"];
    seal(broken.manifest);
    assert.throws(() => h.api.validate(broken.manifest, "4.7.2"), /cycle/);
    assert.throws(() => h.api.validate(first.manifest, "4.7.1"), /version/);
    const damaged = release();
    damaged.manifest.packs.b.pck_sha256 = "0".repeat(64);
    seal(damaged.manifest);
    const fresh = harness();
    fresh.use(damaged);
    await assert.rejects(fresh.prepare(), /b:.*SHA-256/);
    const coalesced = harness();
    coalesced.use(first);
    await Promise.all([coalesced.prepare(), coalesced.prepare()]);
    assert.equal(
        coalesced.downloads.length,
        4,
        "Concurrent requests for the same compressed content must merge"
    );
    const invalidBr = harness();
    invalidBr.use(release());
    invalidBr.network.set(
        "https://cdn.example/game/" + invalidBr.manifest.packs.b.url,
        Buffer.from("damaged")
    );
    await assert.rejects(invalidBr.prepare(), /b:.*Compressed pack hash\/size mismatch/);
    assert(
        ![...invalidBr.saved.keys()].some((k) => k.includes(".partial-")),
        "Failed downloads must clean partial writes"
    );
    const failedDecode = harness();
    failedDecode.use(first);
    const successful = await failedDecode.prepare();
    await failedDecode.api.commit(successful);
    failedDecode.use(release("undecodable"));
    const originalDecoder = failedDecode.decoder;
    failedDecode.decoder = (bytes) => {
        const decoded = originalDecoder(bytes);
        if (decoded.includes(Buffer.from("undecodable"))) throw new Error("decoder failure");
        return decoded;
    };
    const restored = await failedDecode.prepare();
    assert.equal(
        restored.manifest.release_id,
        first.manifest.release_id,
        "Decompression failure falls back to the complete previous release"
    );
    assert.equal(restored.fallback, true);
    const interruption = harness();
    interruption.use(release());
    interruption.network.clear();
    await assert.rejects(interruption.prepare(), /offline/);
    assert(
        ![...interruption.saved.keys()].some((k) => k.endsWith("successful.json")),
        "Interrupted first download must not commit"
    );
    const waiting = h.api.waitForScene("res://a/A.tscn", 100);
    h.api.sceneReady("res://wrong.tscn");
    h.api.sceneReady("res://a/A.tscn");
    await waiting;
    await assert.rejects(h.api.waitForScene("res://a/A.tscn", 1), /timed out/);
    for (const failStartup of [false, true]) {
        const sdk = harness();
        sdk.use(first);
        const events = [];
        sdk.context.Engine = class {
            constructor() {
                this.rtenv = {
                    copyToFS(p) {
                        events.push(p);
                    },
                };
            }
            init() {
                events.push("init");
                return Promise.resolve();
            }
            start(options) {
                assert.equal(events.length, 5, "Every pack must be installed before main() starts");
                assert.deepEqual(Array.from(options.args), [
                    "--main-pack",
                    "/scene-packs/bootstrap.pck",
                    "--extra-pack",
                    "/scene-packs/c.pck",
                    "--extra-pack",
                    "/scene-packs/b.pck",
                    "--extra-pack",
                    "/scene-packs/a.pck",
                ]);
                if (failStartup) return Promise.reject(new Error("startup failed"));
                setTimeout(() => {
                    assert(
                        ![...sdk.saved.keys()].some((k) => k.endsWith("successful.json")),
                        "Engine.start alone must not commit"
                    );
                    sdk.api.sceneReady(first.manifest.entry_scene);
                }, 2);
                return Promise.resolve();
            }
        };
        sdk.context.Engine.scenePackProtocol = 2;
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, "../wechat/engine/godot-sdk.js"), "utf8"),
            sdk.context
        );
        const startup = sdk.context.GameGlobal.GODOTSDK.startGame(
            "/engine/godot",
            {
                mode: "manifest",
                manifest_url: "https://cdn.example/game/manifest.json",
                engine_version: "4.7.2",
            },
            sdk.decoder
        );
        if (failStartup) {
            await assert.rejects(startup, /startup failed/);
            assert(![...sdk.saved.keys()].some((k) => k.endsWith("successful.json")));
        } else {
            await startup;
            assert([...sdk.saved.keys()].some((k) => k.endsWith("successful.json")));
        }
    }
    console.log(
        "Manifest graph, Brotli cache, B-only update, atomic commit and offline release tests passed"
    );
}

function catalog(version) {
    const value = release(version),
        manifest = value.manifest;
    manifest.schema = 3;
    manifest.project_scene = "res://a/A.tscn";
    delete manifest.entry_scene;
    manifest.scene_to_pack["res://x/X.tscn"] = "x";
    manifest.packs.x.files = ["res://x/X.tscn"];
    seal(manifest);
    return value;
}
async function catalogTests() {
    const first = catalog(),
        h = harness();
    h.use(first);
    const session = await h.prepare("res://x/X.tscn");
    assert.equal(session.scene, "res://x/X.tscn");
    assert.deepEqual(Array.from(session.ids), ["bootstrap", "x"]);
    const copied = new Map(),
        mounted = [];
    const copy = (p, b) => copied.set(p, b);
    await h.api.install(session, h.decoder, copy);
    await h.api.commit(session);
    h.api.activate(session, h.decoder, copy);
    h.api.registerSceneLoader((payload) => {
        const request = JSON.parse(payload);
        if (request.event) return;
        mounted.push(request);
        request.packs.forEach((p) => assert(copied.has(p)));
        setTimeout(() => h.api.sceneLoaded(request.id, request.scene, ""), 1);
    });
    // Server changes must never replace the active manifest or bring in newer B.
    h.manifest = catalog("two").manifest;
    const loading = h.api.loadScene("res://a/A.tscn");
    assert.strictEqual(h.api.loadScene("res://a/A.tscn"), loading, "Same-scene calls merge");
    await loading;
    assert.deepEqual(mounted[0].packs, [
        "/scene-packs/c.pck",
        "/scene-packs/b.pck",
        "/scene-packs/a.pck",
    ]);
    assert.equal(h.downloads.length, 5);
    assert(h.downloads.some((url) => url.includes(first.manifest.packs.b.br_sha256)));
    await h.api.loadScene("res://x/X.tscn");
    assert.deepEqual(mounted[1].packs, [], "Previously mounted packs are never mounted again");
    await h.api.loadScene("res://a/A.tscn");
    assert.equal(h.downloads.length, 5);
    await assert.rejects(h.api.loadScene("res://unknown.tscn"), /not in this release/);
    // A fresh X launch keeps caches for other scenes in the same release.
    h.use(first);
    await h.api.commit(await h.prepare("res://x/X.tscn"));
    assert([...h.saved.keys()].some((p) => p.includes(first.manifest.packs.b.br_sha256)));
    h.offline = true;
    assert.equal((await h.prepare("res://a/A.tscn")).fallback, true);
    const noDefault = catalog();
    noDefault.manifest.project_scene = "";
    seal(noDefault.manifest);
    const fresh = harness();
    fresh.use(noDefault);
    await assert.rejects(fresh.prepare(), /No engine default scene/);
    assert.deepEqual(Array.from((await fresh.prepare("res://x/X.tscn")).ids), ["bootstrap", "x"]);
    const locked = catalog();
    locked.manifest.scene_override = false;
    seal(locked.manifest);
    const lockedHost = harness();
    lockedHost.use(locked);
    await assert.rejects(lockedHost.prepare("res://x/X.tscn"), /disable runtime startup overrides/);
    assert.equal((await lockedHost.prepare()).scene, "res://a/A.tscn");
    const damagedIndex = catalog();
    delete damagedIndex.manifest.scene_to_pack["res://x/X.tscn"];
    seal(damagedIndex.manifest);
    assert.throws(
        () => fresh.api.validate(damagedIndex.manifest, "4.7.2"),
        /Missing scene mapping/
    );
    // Download failure during a later scene request leaves the engine usable and allows retry.
    const retry = harness();
    retry.use(first);
    const retrySession = await retry.prepare("res://x/X.tscn");
    await retry.api.install(retrySession, retry.decoder, () => {});
    let finishStartup;
    retry.api.activate(
        retrySession,
        retry.decoder,
        () => {},
        new Promise((resolve) => {
            finishStartup = resolve;
        })
    );
    let calls = 0;
    retry.api.registerSceneLoader((payload) => {
        calls++;
        const request = JSON.parse(payload);
        retry.api.sceneLoaded(request.id, request.scene, "");
    });
    const earlyRequest = retry.api.loadScene("res://x/X.tscn");
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(
        calls,
        0,
        "Requests during initial scene readiness must wait for startup to commit"
    );
    finishStartup();
    await earlyRequest;
    calls = 0;
    retry.network = new Map();
    await assert.rejects(retry.api.loadScene("res://a/A.tscn"), /offline/);
    assert.equal(calls, 0, "Failed downloads must not change the running scene");
    retry.network = first.files;
    await retry.api.loadScene("res://a/A.tscn");
    assert.equal(calls, 1);
    retry.api.registerSceneLoader((payload) => {
        const request = JSON.parse(payload);
        retry.api.sceneLoaded(request.id, request.scene, "mount failed");
    });
    await assert.rejects(retry.api.loadScene("res://x/X.tscn"), /mount failed/);
    await assert.rejects(retry.api.loadScene("res://a/A.tscn"), /restart/);
    // Web templates use an in-memory settings override and await the chosen scene.
    const sdk = harness();
    sdk.use(first);
    sdk.context.Engine = class {
        constructor() {
            this.rtenv = {
                copyToFS(p, bytes) {
                    if (p.endsWith("override.cfg"))
                        assert(
                            Buffer.from(bytes)
                                .toString()
                                .includes('run/main_scene="res://x/X.tscn"')
                        );
                },
            };
        }
        init() {
            return Promise.resolve();
        }
        start(options) {
            assert.deepEqual(Array.from(options.args), [
                "--main-pack",
                "/scene-packs/bootstrap.pck",
                "--extra-pack",
                "/scene-packs/x.pck",
            ]);
            setTimeout(() => sdk.api.sceneReady("res://x/X.tscn"), 1);
            return Promise.resolve();
        }
    };
    sdk.context.Engine.scenePackProtocol = 2;
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, "../wechat/engine/godot-sdk.js"), "utf8"),
        sdk.context
    );
    await sdk.context.GameGlobal.GODOTSDK.startGame(
        "/engine/godot",
        {
            mode: "manifest",
            manifest_url: "https://cdn.example/game/manifest.json",
            engine_version: "4.7.2",
            scene: "res://x/X.tscn",
        },
        sdk.decoder
    );
    console.log(
        "Full-project catalog, independent startup, late scene loading and pinned-version cache tests passed"
    );
}
module.exports = { harness, catalog, seal };
if (require.main === module)
    tests().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
