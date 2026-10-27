(function (global) {
    "use strict";
    const root = global.GameGlobal || (global.GameGlobal = {});
    const wx = global.wx;
    const fs = wx && wx.getFileSystemManager && wx.getFileSystemManager();
    const pending = new Map();
    let serial = 0;
    let waiting = null;
    let sceneLoader = null;
    let running = null;
    let sceneQueue = Promise.resolve();
    const sceneRequests = new Map();
    const mountRequests = new Map();
    const HASH = /^[0-9a-f]{64}$/;
    const ID = /^[a-z][a-z0-9_-]{0,47}$/;

    function canonical(value) {
        if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
        if (value && typeof value === "object") {
            return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
        }
        return JSON.stringify(value);
    }
    function hashText(value) {
        return root.remotePack.sha256(utf8(value));
    }
    function utf8(value) {
        // No TextEncoder dependency: the WeChat host may not provide one.
        const text = unescape(encodeURIComponent(value));
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return bytes;
    }
    function https(url) {
        return typeof url === "string" && /^https:\/\/[^/?#@\s]+\/[^?#\s]*$/.test(url);
    }
    function validate(manifest, engineVersion) {
        if (!manifest || ![2, 3].includes(manifest.schema) || typeof manifest.project_id !== "string" || !manifest.project_id ||
            manifest.engine_version !== engineVersion || !HASH.test(manifest.release_id) ||
            manifest.bootstrap !== "bootstrap" || !manifest.packs || Array.isArray(manifest.packs) ||
            !manifest.scene_to_pack || Array.isArray(manifest.scene_to_pack) ||
            (manifest.schema === 2 ? typeof manifest.entry_scene !== "string" : typeof manifest.project_scene !== "string")) throw new Error("Invalid scene manifest/version");
        const content = Object.assign({}, manifest);
        delete content.release_id;
        if (hashText(canonical(content)) !== manifest.release_id) throw new Error("Manifest content hash mismatch");
        const owners = new Map();
        for (const [id, pack] of Object.entries(manifest.packs)) {
            if (!ID.test(id) || !pack || pack.compression !== "br" ||
                !HASH.test(pack.br_sha256) || !HASH.test(pack.pck_sha256) ||
                !Number.isSafeInteger(pack.br_size) || pack.br_size <= 0 ||
                !Number.isSafeInteger(pack.pck_size) || pack.pck_size < 20 ||
                pack.url !== `packs/${id}-${pack.br_sha256}.pck.br` ||
                !Array.isArray(pack.depends) || !Array.isArray(pack.files)) throw new Error("Invalid pack: " + id);
            for (const file of pack.files) {
                if (typeof file !== "string" || !file.startsWith("res://") || file.split("/").includes("..") || owners.has(file)) {
                    throw new Error("Invalid/duplicate resource: " + file);
                }
                owners.set(file, id);
            }
            for (const dep of pack.depends) {
                if (!Object.prototype.hasOwnProperty.call(manifest.packs, dep) || dep === id) throw new Error("Unknown dependency: " + dep);
            }
        }
        for (const [scene, id] of Object.entries(manifest.scene_to_pack)) {
            if (owners.get(scene) !== id || !/\.(tscn|scn)$/.test(scene)) throw new Error("Invalid scene mapping: " + scene);
        }
        const projectScene = manifest.schema === 2 ? manifest.entry_scene : manifest.project_scene;
        if (manifest.scene_override !== undefined && typeof manifest.scene_override !== "boolean") throw new Error("Invalid scene override capability");
        if (!manifest.packs.bootstrap || (projectScene && !Object.prototype.hasOwnProperty.call(manifest.scene_to_pack, projectScene)) ||
            (manifest.schema === 2 && !projectScene)) throw new Error("Missing project scene/bootstrap");
        for (const [file, id] of owners) {
            if (/\.(tscn|scn)$/.test(file) && manifest.scene_to_pack[file] !== id) throw new Error("Missing scene mapping: " + file);
        }
        order(manifest, Object.keys(manifest.packs)); // Validate even unreachable cycles.
        return manifest;
    }
    function order(manifest, roots) {
        const done = new Set(), active = new Set(), result = [];
        function visit(id) {
            if (active.has(id)) throw new Error("Pack dependency cycle: " + id);
            if (done.has(id)) return;
            if (!manifest.packs[id]) throw new Error("Unknown pack: " + id);
            active.add(id);
            manifest.packs[id].depends.forEach(visit);
            active.delete(id); done.add(id); result.push(id);
        }
        roots.forEach(visit);
        return result;
    }
    function io(method, options) {
        return new Promise((resolve, reject) => {
            if (!fs || !fs[method]) return reject(new Error("WeChat filesystem unavailable: " + method));
            fs[method](Object.assign({}, options, { success: resolve, fail: e => reject(new Error(e.errMsg || method + " failed")) }));
        });
    }
    function notify(callback, stage, id, percent) {
        if (callback) callback({ stage, pack: id, percent });
    }
    function request(url) {
        return new Promise((resolve, reject) => {
            wx.request({ url, method: "GET", dataType: "text", responseType: "text", timeout: 30000,
                header: { "Cache-Control": "no-cache" },
                success: r => {
                    if (r.statusCode !== 200) return reject(new Error("Manifest HTTP " + r.statusCode));
                    try { resolve(typeof r.data === "string" ? JSON.parse(r.data) : r.data); } catch (e) { reject(e); }
                }, fail: e => reject(new Error(e.errMsg || "Manifest request failed")) });
        });
    }
    function download(url, callback, id) {
        return new Promise((resolve, reject) => {
            const task = wx.downloadFile({ url, timeout: 60000,
                success: r => r.statusCode === 200 && r.tempFilePath ? resolve(r.tempFilePath) : reject(new Error(id + ": HTTP " + r.statusCode)),
                fail: e => reject(new Error(id + ": " + (e.errMsg || "Download failed"))) });
            if (task && task.onProgressUpdate) task.onProgressUpdate(r => notify(callback, "download", id, r.progress));
        });
    }
    function cacheFile(session, id) {
        const m = session.manifest;
        return session.directory + "/" + hashText(m.project_id + "@" + m.engine_version).slice(0, 16) + "-" + m.packs[id].br_sha256 + ".br";
    }
    function checkCompressed(data, pack) {
        if ((data.byteLength === undefined ? data.length : data.byteLength) !== pack.br_size || root.remotePack.sha256(data) !== pack.br_sha256) {
            throw new Error("Compressed pack hash/size mismatch");
        }
    }
    async function compressed(session, id, offline, callback) {
        try { await getCompressed(session, id, offline, callback); }
        catch (error) { throw new Error(id + ": " + error.message); }
    }
    async function getCompressed(session, id, offline, callback) {
        const destination = cacheFile(session, id), pack = session.manifest.packs[id];
        try {
            const data = (await io("readFile", { filePath: destination })).data;
            notify(callback, "verify", id, 0);
            checkCompressed(data, pack);
            notify(callback, "verify", id, 100);
            return;
        } catch (error) {
            if (offline) throw new Error("cached pack unavailable: " + error.message);
        }
        if (!pending.has(destination)) {
            pending.set(destination, (async () => {
                const path = await download(session.base + pack.url, callback, id);
                const temporary = destination + ".partial-" + (++serial);
                try {
                    const data = (await io("readFile", { filePath: path })).data;
                    notify(callback, "verify", id, 0);
                    checkCompressed(data, pack);
                    notify(callback, "verify", id, 100);
                    await io("copyFile", { srcPath: path, destPath: temporary });
                    // Same name means same immutable content; a damaged existing copy may be removed.
                    await io("unlink", { filePath: destination }).catch(() => {});
                    await io("rename", { oldPath: temporary, newPath: destination });
                } finally {
                    await io("unlink", { filePath: temporary }).catch(() => {});
                    await io("unlink", { filePath: path }).catch(() => {});
                }
            })().finally(() => pending.delete(destination)));
        }
        await pending.get(destination);
    }
    async function decode(session, id, decoder, callback) {
        notify(callback, "decode", id, 0);
        try {
            const data = (await io("readFile", { filePath: cacheFile(session, id) })).data;
            const bytes = root.remotePack.decodeCompressed(data,
                Object.assign({ engine_version: session.manifest.engine_version }, session.manifest.packs[id]), decoder);
            notify(callback, "decode", id, 100);
            return bytes;
        } catch (error) { throw new Error(id + ": " + error.message); }
    }
    function scenePacks(manifest, scene) {
        if (typeof scene !== "string" || !Object.prototype.hasOwnProperty.call(manifest.scene_to_pack, scene)) {
            throw new Error("Scene is not in this release: " + scene);
        }
        return order(manifest, ["bootstrap", manifest.scene_to_pack[scene]]);
    }
    function chooseScene(manifest, requested) {
        const scene = requested || (manifest.schema === 2 ? manifest.entry_scene : manifest.project_scene);
        if (!scene) throw new Error("No engine default scene; specify scene in the runtime configuration");
        scenePacks(manifest, scene);
        if (requested && requested !== (manifest.project_scene || manifest.entry_scene) && manifest.scene_override === false) {
            throw new Error("Project settings disable runtime startup overrides; enable project settings overrides or switch scenes after startup");
        }
        return scene;
    }
    function startupOverride(session) {
        return utf8("[application]\nrun/main_scene=" + JSON.stringify(session.scene) + "\n");
    }
    async function obtainPacks(session, ids, decoder, offline, callback) {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(3, ids.length) }, async () => {
            while (cursor < ids.length) {
                const id = ids[cursor++];
                await compressed(session, id, offline, callback);
            }
        });
        // Wait for every in-flight write before considering a fallback/cleanup.
        const outcomes = await Promise.all(workers.map(p => p.then(() => null, e => e)));
        const error = outcomes.find(Boolean);
        if (error) throw error;
        for (const id of ids) await decode(session, id, decoder, callback);
    }
    async function obtain(session, decoder, offline, callback, requested) {
        session.scene = chooseScene(session.manifest, requested);
        session.ids = scenePacks(session.manifest, session.scene);
        await obtainPacks(session, session.ids, decoder, offline, callback);
        return session;
    }
    async function prepare(config, decoder, callback) {
        if (!config || !https(config.manifest_url) || !/^\d+\.\d+\.\d+$/.test(config.engine_version)) throw new Error("Invalid manifest startup config");
        const directory = wx.env.USER_DATA_PATH + "/scene-packs-" + hashText(config.manifest_url).slice(0, 24);
        await io("mkdir", { dirPath: directory, recursive: true }).catch(() => {});
        let previous = null;
        try {
            const saved = await io("readFile", { filePath: directory + "/successful.json", encoding: "utf8" });
            previous = validate(JSON.parse(saved.data), config.engine_version);
        } catch (_) { /* No trusted successful release yet. */ }
        const base = config.manifest_url.slice(0, config.manifest_url.lastIndexOf("/") + 1);
        try {
            notify(callback, "manifest", "", 0);
            const manifest = validate(await request(config.manifest_url), config.engine_version);
            if (previous && manifest.project_id !== previous.project_id) throw new Error("Manifest project identity changed");
            return await obtain({ manifest, previous, directory, base, fallback: false }, decoder, false, callback, config.scene);
        } catch (error) {
            if (!previous) throw error;
            console.warn("Using complete previous scene-pack release", error);
            return obtain({ manifest: previous, previous, directory, base, fallback: true }, decoder, true, callback, config.scene);
        }
    }
    async function install(session, decoder, copy, callback) {
        const paths = {};
        for (const id of session.ids) {
            const path = "/scene-packs/" + id + ".pck";
            const bytes = await decode(session, id, decoder, callback);
            copy(path, bytes);
            paths[id] = path;
        }
        return { main: paths.bootstrap, extra: session.ids.filter(id => id !== "bootstrap").map(id => paths[id]) };
    }
    async function commit(session) {
        const temporary = session.directory + "/successful.partial-" + (++serial);
        try {
            await io("writeFile", { filePath: temporary, data: canonical(session.manifest), encoding: "utf8" });
            // Atomic replacement; do not unlink the previous successful pointer on failure.
            await io("rename", { oldPath: temporary, newPath: session.directory + "/successful.json" });
        } finally {
            await io("unlink", { filePath: temporary }).catch(() => {});
        }
        // Retain cached scenes from this release even when this launch did not visit them.
        const keep = new Set(Object.keys(session.manifest.packs).map(id => cacheFile(session, id).split("/").pop()));
        try {
            const listing = await io("readdir", { dirPath: session.directory });
            for (const file of listing.files) {
                if (/^[0-9a-f]{16}-[0-9a-f]{64}\.br$/.test(file) && !keep.has(file)) {
                    await io("unlink", { filePath: session.directory + "/" + file }).catch(() => {});
                }
            }
        } catch (_) { /* Cache reclamation is best effort after the pointer commits. */ }
    }
    function waitForScene(scene, timeout = 60000) {
        if (waiting) throw new Error("A scene startup is already pending");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiting = null; reject(new Error("Scene startup timed out; restart to retry")); }, timeout);
            waiting = { scene, resolve, reject, timer };
        });
    }
    function cancelWait(error) {
        if (!waiting) return;
        clearTimeout(waiting.timer);
        waiting.reject(error);
        waiting = null;
    }
    function activate(session, decoder, copy, ready = Promise.resolve()) {
        running = { session, decoder, copy, ready, installed: new Set(session.ids), failed: false };
    }
    function mountScene(scene, paths) {
        if (!sceneLoader) return Promise.reject(new Error("Scene loading bridge is unavailable; update the exported bootstrap pack"));
        return new Promise((resolve, reject) => {
            const id = ++serial;
            const timer = setTimeout(() => {
                mountRequests.delete(id);
                reject(new Error("Scene load timed out; restart to retry"));
            }, 60000);
            mountRequests.set(id, { scene, resolve, reject, timer });
            try { sceneLoader(JSON.stringify({ id, scene, packs: paths })); }
            catch (error) { clearTimeout(timer); mountRequests.delete(id); reject(error); }
        });
    }
    function loadScene(scene, callback) {
        if (sceneRequests.has(scene)) return sceneRequests.get(scene);
        const active = running;
        const task = sceneQueue.then(async () => {
            if (!active || active !== running) throw new Error("Start a manifest session before loading a scene");
            await active.ready;
            if (active.failed) throw new Error("Scene engine state is uncertain; restart to retry");
            if (!sceneLoader) throw new Error("Scene loading bridge is unavailable; update the exported bootstrap pack");
            const { session, decoder, copy } = active;
            const ids = scenePacks(session.manifest, scene).filter(id => !active.installed.has(id));
            // Validate all bytes before touching the engine; never change releases mid-run.
            await obtainPacks(session, ids, decoder, session.fallback, callback);
            const paths = [];
            for (const id of ids) {
                const path = "/scene-packs/" + id + ".pck";
                copy(path, await decode(session, id, decoder, callback));
                paths.push(path);
            }
            notify(callback, "start", scene, 0);
            try { await mountScene(scene, paths); }
            catch (error) { active.failed = true; throw error; }
            ids.forEach(id => active.installed.add(id));
            session.scene = scene;
            notify(callback, "start", scene, 100);
            return scene;
        });
        sceneQueue = task.catch(() => {});
        const shared = task.finally(() => sceneRequests.delete(scene));
        sceneRequests.set(scene, shared);
        return shared;
    }
    root.manifestPacks = { canonical, hashText, validate, order, scenePacks, prepare, install, commit, waitForScene, cancelWait,
        activate, loadScene, startupOverride,
        registerSceneLoader(callback) { sceneLoader = callback; },
        sceneLoaded(id, scene, error) {
            const request = mountRequests.get(id);
            if (!request) return;
            clearTimeout(request.timer); mountRequests.delete(id);
            if (error || request.scene !== scene) request.reject(new Error(error || "Loaded scene does not match request"));
            else request.resolve();
        },
        requestScene(scene) {
            loadScene(scene).then(() => {
                if (sceneLoader) sceneLoader(JSON.stringify({ event: "loaded", scene }));
            }, error => {
                if (sceneLoader) sceneLoader(JSON.stringify({ event: "error", scene, error: error.message }));
            });
        },
        sceneReady(scene) {
            if (waiting && waiting.scene === scene) {
                clearTimeout(waiting.timer);
                waiting.resolve();
                waiting = null;
            }
        } };
})(typeof globalThis !== "undefined" ? globalThis : this);
