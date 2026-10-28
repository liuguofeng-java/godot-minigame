const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const createdContexts = [];

class FakeInnerAudioContext {
    constructor() {
        this.listeners = new Map();
        this._src = "";
        this.srcAssignments = 0;
        this.destroyed = false;
        this.autoplay = false;
        this.loop = false;
        this.volume = 1;
        this.playbackRate = 1;
        this.startTime = 0;
        createdContexts.push(this);
    }

    get src() {
        return this._src;
    }

    set src(value) {
        this._src = value;
        this.srcAssignments += 1;
    }

    on(name, callback) {
        this.listeners.set(name, callback);
    }
    off(name) {
        this.listeners.delete(name);
    }
    onCanplay(callback) {
        this.on("canplay", callback);
    }
    onPlay(callback) {
        this.on("play", callback);
    }
    onPause(callback) {
        this.on("pause", callback);
    }
    onStop(callback) {
        this.on("stop", callback);
    }
    onEnded(callback) {
        this.on("ended", callback);
    }
    onTimeUpdate(callback) {
        this.on("timeupdate", callback);
    }
    onError(callback) {
        this.on("error", callback);
    }
    onWaiting(callback) {
        this.on("waiting", callback);
    }
    onSeeking(callback) {
        this.on("seeking", callback);
    }
    onSeeked(callback) {
        this.on("seeked", callback);
    }
    offCanplay() {
        this.off("canplay");
    }
    offPlay() {
        this.off("play");
    }
    offPause() {
        this.off("pause");
    }
    offStop() {
        this.off("stop");
    }
    offEnded() {
        this.off("ended");
    }
    offTimeUpdate() {
        this.off("timeupdate");
    }
    offError() {
        this.off("error");
    }
    offWaiting() {
        this.off("waiting");
    }
    offSeeking() {
        this.off("seeking");
    }
    offSeeked() {
        this.off("seeked");
    }
    stop() {}
    destroy() {
        this.destroyed = true;
    }
}

const context = {
    ArrayBuffer,
    DataView,
    GameGlobal: {},
    GodotRuntime: {},
    HEAPF32: new Float32Array(0),
    HEAPU8: new Uint8Array(0),
    LibraryManager: { library: {} },
    Map,
    Math,
    Number,
    Promise,
    Set,
    Uint8Array,
    console,
    autoAddDeps() {},
    mergeInto() {},
    wx: {
        createInnerAudioContext: () => new FakeInnerAudioContext(),
    },
};

const defaultSourcePath = path.resolve(
    __dirname,
    "../engine/sources/platform/web/js/libs/library_godot_audio.js"
);
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultSourcePath;

vm.createContext(context);
const source =
    fs.readFileSync(sourcePath, "utf8") +
    "\n;globalThis.GodotAudio = _GodotAudio.$GodotAudio; globalThis.__GodotAudio = GodotAudio;";
vm.runInContext(source, context);

const audio = context.__GodotAudio.WX;
audio.contextPool = [];

function acquire(src) {
    const ctx = audio.getContext(src);
    if (ctx.src !== src) {
        ctx.src = src;
    }
    return ctx;
}

const contextA = acquire("audio/a.mp3");
audio.releaseContext(contextA);
const contextB = acquire("audio/b.mp3");
assert.notStrictEqual(contextB, contextA, "different sources must not share a context");
audio.releaseContext(contextB);

assert.strictEqual(acquire("audio/a.mp3"), contextA, "same-source context must be reused");
audio.releaseContext(contextA);
assert.strictEqual(acquire("audio/b.mp3"), contextB, "same-source context must be reused");
audio.releaseContext(contextB);

for (let i = 0; i < 30; i += 1) {
    const src = i % 2 === 0 ? "audio/a.mp3" : "audio/b.mp3";
    const expected = i % 2 === 0 ? contextA : contextB;
    const ctx = acquire(src);
    assert.strictEqual(ctx, expected);
    audio.releaseContext(ctx);
}

assert.strictEqual(contextA.srcAssignments, 1);
assert.strictEqual(contextB.srcAssignments, 1);
assert.strictEqual(createdContexts.length, 2);

audio.contextPool = [];
const capacityContexts = [];
for (let i = 0; i <= audio.MAX_POOL_SIZE; i += 1) {
    const ctx = acquire(`audio/capacity-${i}.mp3`);
    capacityContexts.push(ctx);
    audio.releaseContext(ctx);
}

assert.strictEqual(audio.contextPool.length, audio.MAX_POOL_SIZE);
assert.strictEqual(
    capacityContexts[audio.MAX_POOL_SIZE].destroyed,
    true,
    "the context exceeding pool capacity must be destroyed"
);
assert.strictEqual(
    capacityContexts.slice(0, audio.MAX_POOL_SIZE).some((ctx) => ctx.destroyed),
    false
);

// Eviction must respect active playback references and cache locks.
const deletedFiles = [];
audio.fs = {
    statSync() {
        return {};
    },
    unlinkSync(file) {
        deletedFiles.push(file);
    },
};
audio.cacheLimitBytes = 10;
audio.cacheBytes = 9;
audio.cacheRecords = new Map([
    ["playing", { hash: "playing", size: 4, path: "playing.mp3", lastAccess: 1 }],
    ["old", { hash: "old", size: 3, path: "old.mp3", lastAccess: 2 }],
    ["locked", { hash: "locked", size: 2, path: "locked.mp3", lastAccess: 3 }],
]);
audio.cacheRefs = new Map([["playing", 1]]);
audio.cacheLocks = new Set(["locked"]);
audio.invalidCacheHashes = new Set();
audio.cacheHashStreams = new Map();
audio.nativeStreams = new Map();
assert.strictEqual(audio.evictFor(4, ""), true);
assert.deepStrictEqual(deletedFiles, ["old.mp3"]);
assert.strictEqual(audio.cacheBytes, 6);
assert.strictEqual(audio.evictFor(5, ""), false);
assert.strictEqual(audio.evictFor(11, ""), false);
assert.strictEqual(audio.cacheRecords.has("playing"), true);
assert.strictEqual(audio.cacheRecords.has("locked"), true);

console.log("WeChat audio source-reuse and cache-bound tests passed");
