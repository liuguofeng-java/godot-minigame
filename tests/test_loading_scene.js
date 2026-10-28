"use strict";
const assert = require("assert"),
    fs = require("fs"),
    path = require("path"),
    vm = require("vm");
const { harness, catalog, seal } = require("./test_manifest_packs");
const PAGE = "res://x/X.tscn",
    GAME = "res://a/A.tscn";
function release(version) {
    const r = catalog(version);
    Object.assign(r.manifest, { schema: 4, startup_mode: "godot_loading", project_scene: PAGE });
    seal(r.manifest);
    return r;
}
function mount(h, session, ready = Promise.resolve()) {
    const commands = [],
        events = [],
        copies = [];
    h.api.activate(session, h.decoder, (name, bytes) => copies.push([name, bytes.length]), ready);
    h.api.registerSceneLoader((payload) => {
        const event = JSON.parse(payload);
        if (event.event) {
            events.push(event);
            return;
        }
        commands.push(event);
        h.api.sceneLoaded(event.id, event.scene, "");
    }, 2);
    return { commands, events, copies };
}
const pointer = (h) => [...h.saved.keys()].find((p) => p.endsWith("successful.json"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function tests() {
    const first = release(),
        h = harness();
    h.use(first);
    const session = await h.prepare();
    assert.deepEqual(Array.from(session.ids), ["bootstrap", "x"]);
    assert.equal(h.downloads.length, 2, "Only loading page dependencies before Godot starts");
    await assert.rejects(h.prepare(GAME), /loading/i);
    await assert.rejects(h.api.commit(session), /Loading page/);
    let startupReady;
    const gate = new Promise((resolve) => {
        startupReady = resolve;
    });
    let decoded = 0;
    const decode = h.decoder;
    h.decoder = (bytes) => {
        decoded++;
        return decode(bytes);
    };
    const mounted = mount(h, session, gate),
        progress = [],
        secondProgress = [];
    const request = h.api.prepareScene(GAME, (p) => progress.push(p));
    assert.strictEqual(
        request,
        h.api.prepareScene(GAME, (p) => secondProgress.push(p))
    );
    await tick();
    assert.equal(h.downloads.length, 2);
    startupReady();
    await request;
    assert.equal(decoded, 3, "Runtime decodes each missing PCK only once");
    assert.equal(h.downloads.length, 5);
    assert(h.maximum <= 3);
    assert.equal(mounted.commands.length, 3);
    assert.equal(mounted.commands[0].command, "prepare", "Preparation never switches the scene");
    assert.equal(mounted.copies.length, 3);
    assert.equal(pointer(h), undefined, "Packs ready does not mean game ready");
    assert.deepEqual(progress, secondProgress);
    for (const stage of ["download", "verify", "decode", "mount"])
        assert(progress.some((p) => p.stage === stage));
    const endDownload = progress.filter((p) => p.stage === "download").at(-1);
    assert.equal(
        endDownload.total,
        ["a", "b", "c"].reduce((sum, id) => sum + first.manifest.packs[id].br_size, 0)
    );
    assert.equal(endDownload.completed, endDownload.total);
    await h.api.prepareScene(PAGE);
    await h.api.prepareScene(GAME);
    assert.equal(decoded, 3);
    assert.equal(mounted.commands.length, 3);
    await assert.rejects(h.api.confirmScene(PAGE), /Loading page/);
    h.badRename = true;
    await assert.rejects(h.api.confirmScene(GAME), /disk failure/);
    assert.equal(pointer(h), undefined);
    h.badRename = false;
    await h.api.confirmScene(GAME);
    const oldPointer = Buffer.from(h.saved.get(pointer(h))),
        oldB = first.manifest.packs.b.br_sha256;
    assert.equal(JSON.parse(oldPointer).confirmed_scene, GAME);

    // Changed gameplay keeps the old successful record and B until business readiness.
    const updated = release("two");
    h.use(updated);
    const next = await h.prepare();
    mount(h, next);
    h.network = new Map();
    await assert.rejects(h.api.prepareScene(GAME), /b:.*offline/);
    assert(h.saved.get(pointer(h)).equals(oldPointer));
    assert([...h.saved.keys()].some((p) => p.includes(oldB)));
    h.network = updated.files;
    const beforeRetry = h.downloads.length;
    await h.api.prepareScene(GAME);
    assert.equal(h.downloads.length, beforeRetry + 1, "Only changed B is downloaded after retry");
    assert(h.saved.get(pointer(h)).equals(oldPointer));
    // Restart callback failure clears the marker; success pins the entire old release next launch.
    h.context.wx.restartMiniProgram = ({ fail }) => fail({ errMsg: "restart unavailable" });
    await assert.rejects(h.api.restartPrevious(), /restart unavailable/);
    assert(![...h.saved.keys()].some((p) => p.endsWith("rollback.json")));
    h.context.wx.restartMiniProgram = ({ success }) => success({});
    await h.api.restartPrevious();
    const rollbackHost = harness(new Map(h.saved));
    rollbackHost.use(updated);
    const rollback = await rollbackHost.prepare();
    assert.equal(rollback.fallback, true);
    assert.equal(rollback.manifest.release_id, first.manifest.release_id);
    assert.equal(rollback.confirmedScene, GAME);
    assert.equal(rollbackHost.downloads.length, 0);
    mount(rollbackHost, rollback);
    await rollbackHost.api.prepareScene(GAME);
    assert.equal(rollbackHost.downloads.length, 0);
    await h.api.confirmScene(GAME);
    assert.equal(
        JSON.parse(h.saved.get(pointer(h))).manifest.release_id,
        updated.manifest.release_id
    );
    assert(![...h.saved.keys()].some((p) => p.includes(oldB)));
    assert(![...h.saved.keys()].some((p) => p.endsWith(".pck")));

    const incomplete = harness(new Map(rollbackHost.saved));
    incomplete.use(updated);
    incomplete.offline = true;
    for (const key of incomplete.saved.keys()) if (key.includes(oldB)) incomplete.saved.delete(key);
    await assert.rejects(incomplete.prepare(), /cached pack unavailable/);
    const offline = harness(new Map(rollbackHost.saved));
    offline.use(updated);
    offline.offline = true;
    assert.equal((await offline.prepare()).manifest.release_id, first.manifest.release_id);

    // Decode failures leave the current manifest pinned and allow resource retry.
    const bad = harness();
    bad.use(first);
    const badSession = await bad.prepare();
    const decoder = bad.decoder;
    bad.decoder = () => {
        throw new Error("decode failed");
    };
    const state = mount(bad, badSession);
    bad.api.requestPrepare(GAME, 17);
    await tick();
    await tick();
    for (let i = 0; i < 50 && !state.events.some((e) => e.event === "failed"); i++) await tick();
    const failure = state.events.find((e) => e.event === "failed");
    assert(failure && failure.retryable && failure.request_id === 17);
    assert.equal(state.commands.length, 0);
    bad.decoder = decoder;
    mount(bad, badSession);
    await bad.api.prepareScene(GAME);
    bad.api.registerSceneLoader((payload) => {
        const e = JSON.parse(payload);
        if (!e.event) bad.api.sceneLoaded(e.id, e.scene, "mount failed");
    }, 2);
    await assert.rejects(bad.api.loadScene(GAME), /mount failed/);
    await assert.rejects(bad.api.prepareScene(GAME), /restart/);

    // SDK starts accepting requests when the page draws, without committing the release.
    const sdk = harness();
    sdk.use(first);
    sdk.context.Engine = class {
        constructor() {
            this.rtenv = { copyToFS() {} };
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
            setTimeout(() => sdk.api.sceneReady(PAGE), 1);
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
        },
        sdk.decoder
    );
    assert.equal(pointer(sdk), undefined);
    assert.equal(sdk.downloads.length, 2);
    const legacy = catalog();
    legacy.manifest.project_scene = "";
    seal(legacy.manifest);
    const raw = harness();
    raw.use(legacy);
    const rawSession = await raw.prepare(PAGE);
    await raw.api.commit(rawSession);
    raw.saved.set(pointer(raw), Buffer.from(JSON.stringify(legacy.manifest)));
    raw.offline = true;
    assert.equal(
        (await raw.prepare(PAGE)).scene,
        PAGE,
        "Legacy raw records support the host's explicit scene"
    );
    console.log(
        "Schema 4 loading page, deferred preparation, readiness commit, compressed cache and restart rollback passed"
    );
}
tests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
