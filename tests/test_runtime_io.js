"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const libs = path.join(__dirname, "../engine/sources/platform/web/js/libs");

// Exercise chunk reads across heap-buffer boundaries and the no-chunk fallback.
{
    const records = new Map();
    let id = 0;
    let request, onHeaders, onChunk;
    const heap = new Uint8Array(32);
    const context = {
        ArrayBuffer, Uint8Array, TextEncoder, console, HEAP8: heap,
        IDHandler: { add(value) { records.set(++id, value); return id; }, get: (key) => records.get(key), remove: (key) => records.delete(key) },
        GodotRuntime: { heapCopy: (target, bytes, offset) => target.set(bytes, offset), error() {} },
        LibraryManager: { library: {} }, autoAddDeps() {}, mergeInto() {},
        wx: { request(options) { request = options; return { onHeadersReceived(fn) { onHeaders = fn; }, onChunkReceived(fn) { onChunk = fn; }, abort() {} }; } },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(libs, "library_godot_fetch.js"), "utf8").replace("const GodotFetch =", "var GodotFetch =") +
        ";globalThis.api=GodotFetch;GodotFetch=GodotFetch.$GodotFetch;", context);
    const key = context.GodotFetch.create("GET", "https://example.invalid/data", {}, null);
    onHeaders({ statusCode: 200, header: {} });
    onChunk({ data: Uint8Array.from([1, 2, 3]).buffer });
    onChunk({ data: Uint8Array.from([4, 5, 6, 7]).buffer });
    assert.equal(context.api.godot_js_fetch_read_chunk(key, 2, 5), 5);
    assert.deepEqual(Array.from(heap.slice(2, 7)), [1, 2, 3, 4, 5]);
    assert.equal(context.api.godot_js_fetch_read_chunk(key, 0, 8), 2);
    assert.deepEqual(Array.from(heap.slice(0, 2)), [6, 7]);
    // Consumed chunks must not cause the final body to be appended a second time.
    request.success({ statusCode: 200, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]).buffer });
    assert.equal(context.api.godot_js_fetch_state_get(key), 2);
    const small = context.GodotFetch.create("GET", "https://example.invalid/small", {}, null);
    request.success({ statusCode: 200, header: {}, data: Uint8Array.from([9, 8]).buffer });
    assert.equal(context.api.godot_js_fetch_read_chunk(small, 0, 8), 2);
    assert.deepEqual(Array.from(heap.slice(0, 2)), [9, 8]);
}

// Persist only the used bytes, release memory, then reopen in a fresh runtime.
{
    const files = new Map();
    const filesystem = {
        writeFileSync(name, data) { files.set(name, typeof data === "string" ? new ArrayBuffer(0) : data.slice(0)); },
        readFileSync(name) { if (!files.has(name)) throw new Error("ENOENT"); return files.get(name).slice(0); },
    };
    function runtime() {
        const context = { console, Uint8Array, GameGlobal: { GODOTSDK: {} },
            FS: { isFile: () => true }, wx: { getFileSystemManager: () => filesystem } };
        vm.createContext(context);
        vm.runInContext(fs.readFileSync(path.join(libs, "library_godot_fs.js"), "utf8"), context);
        context.WXMEMFS.wxBasePath = "wxfile://usr";
        return context.WXMEMFS;
    }
    const api = runtime();
    const node = { mode: 32768, contents: null, usedBytes: 0 };
    const stream = { node, path: "/userfs/test.dat", flags: 513 };
    api.stream_ops.open(stream);
    api.stream_ops.write(stream, Uint8Array.from([1, 2, 3]), 0, 3, 0, false);
    api.stream_ops.write(stream, Uint8Array.from([4]), 0, 1, 3, false);
    const buffer = new Uint8Array(10);
    assert.equal(api.stream_ops.read(stream, buffer, 0, 10, 0), 4);
    assert.deepEqual(Array.from(buffer.slice(0, 4)), [1, 2, 3, 4]);
    api.stream_ops.close(stream);
    assert.equal(files.get("wxfile://usr/test.dat").byteLength, 4);
    const rebooted = runtime();
    const reopened = { node: { mode: 32768, contents: null, usedBytes: 0 }, path: stream.path, flags: 0 };
    rebooted.stream_ops.open(reopened);
    assert.equal(rebooted.stream_ops.read(reopened, buffer, 0, 10, 0), 4);
    assert.deepEqual(Array.from(buffer.slice(0, 4)), [1, 2, 3, 4]);
    rebooted.stream_ops.close(reopened);
}
console.log("Runtime persistence and chunked network tests passed");
