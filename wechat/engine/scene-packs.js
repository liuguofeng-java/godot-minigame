(function (global) {
    "use strict";

    const gameGlobal = global.GameGlobal || (global.GameGlobal = {});
    const wxApi = global.wx;
    const fs = wxApi && wxApi.getFileSystemManager ? wxApi.getFileSystemManager() : null;
    const userDataPath = wxApi && wxApi.env && wxApi.env.USER_DATA_PATH;
    let manifest = null;
    let decodeBr = null;
    const pending = new Map();
    const ready = new Set();

    function fsCall(method, options) {
        return new Promise((resolve, reject) => {
            if (!fs || typeof fs[method] !== "function") {
                reject(new Error("WeChat file system is not available"));
                return;
            }
            fs[method](Object.assign({}, options, {
                success: resolve,
                fail: (error) => reject(new Error(error && error.errMsg || method + " failed")),
            }));
        });
    }

    function report(listeners, percent) {
        for (const listener of listeners) {
            if (typeof listener === "function") listener(percent);
        }
    }

    function localPack(pack, listeners) {
        return new Promise((resolve, reject) => {
            if (!wxApi || typeof wxApi.loadSubpackage !== "function") {
                reject(new Error("wx.loadSubpackage is not available"));
                return;
            }
            const task = wxApi.loadSubpackage({
                name: pack.subpackage,
                success: () => resolve(pack.file),
                fail: (error) => reject(new Error(error && error.errMsg || "Subpackage failed")),
            });
            if (task && typeof task.onProgressUpdate === "function") {
                task.onProgressUpdate((value) => report(listeners, value.progress || 0));
            }
        });
    }

    function download(pack, listeners) {
        return new Promise((resolve, reject) => {
            if (!wxApi || typeof wxApi.downloadFile !== "function") {
                reject(new Error("wx.downloadFile is not available"));
                return;
            }
            const task = wxApi.downloadFile({
                url: pack.url,
                success: (value) => value.statusCode === 200 && value.tempFilePath
                    ? resolve(value.tempFilePath)
                    : reject(new Error("PCK download failed: HTTP " + value.statusCode)),
                fail: (error) => reject(new Error(error && error.errMsg || "PCK download failed")),
            });
            if (task && typeof task.onProgressUpdate === "function") {
                task.onProgressUpdate((value) => report(listeners, value.progress || 0));
            }
        });
    }

    function decoded(bytes, pack) {
        return gameGlobal.remotePack.decodeCompressed(bytes, Object.assign({
            engine_version: manifest.engine_version,
        }, pack), decodeBr);
    }

    async function obtain(pack, listeners) {
        if (pack.mode === "local") {
            const path = await localPack(pack, listeners);
            return decoded((await fsCall("readFile", { filePath: path })).data, pack);
        }
        if (!userDataPath) throw new Error("WeChat cache directory is unavailable");
        const cachedPath = userDataPath + "/scene-pack-" + pack.br_sha256 + ".br";
        try {
            const bytes = (await fsCall("readFile", { filePath: cachedPath })).data;
            const result = decoded(bytes, pack);
            report(listeners, 100);
            return result;
        } catch (_cacheError) {
            // 损坏或缺失的缓存必须重新下载并完整校验。
        }
        const path = await download(pack, listeners);
        const bytes = (await fsCall("readFile", { filePath: path })).data;
        const result = decoded(bytes, pack);
        try {
            await fsCall("copyFile", { srcPath: path, destPath: cachedPath });
        } catch (_copyError) {
            await fsCall("unlink", { filePath: cachedPath }).catch(() => {});
            await fsCall("copyFile", { srcPath: path, destPath: cachedPath }).catch(() => {});
        }
        return result;
    }

    async function loadOne(id, listeners) {
        const pack = manifest.packs[id];
        if (!pack || pack.path !== "/engine/scene-" + id + ".pck") {
            throw new Error("Unknown scene pack: " + id);
        }
        const bytes = await obtain(pack, listeners);
        gameGlobal.GODOTSDK.copy_to_fs(pack.path, bytes);
        ready.add(id);
        report(listeners, 100);
        return pack.path;
    }

    function ensure(id, onProgress, onDone) {
        if (!manifest) {
            if (typeof onDone === "function") onDone(JSON.stringify({ ok: false, error: "Scene pack manifest is not configured" }));
            return;
        }
        if (ready.has(id)) {
            if (typeof onDone === "function") onDone(JSON.stringify({ ok: true, path: manifest.packs[id].path }));
            return;
        }
        let current = pending.get(id);
        if (!current) {
            current = { listeners: [], promise: null };
            current.promise = loadOne(id, current.listeners).finally(() => pending.delete(id));
            pending.set(id, current);
        }
        current.listeners.push(onProgress);
        current.promise.then(
            (path) => { if (typeof onDone === "function") onDone(JSON.stringify({ ok: true, path })); },
            (error) => { if (typeof onDone === "function") onDone(JSON.stringify({ ok: false, error: String(error.message || error) })); },
        );
    }

    gameGlobal.scenePacks = {
        configure(value, decoder) {
            manifest = value;
            decodeBr = decoder;
            gameGlobal.scenePackManifestJSON = value ? JSON.stringify(value) : "";
        },
        ensure,
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
