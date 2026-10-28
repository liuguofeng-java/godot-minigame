(function (global) {
    "use strict";
    const root = global.GameGlobal || (global.GameGlobal = {});
    const wx = global.wx;
    const fs = wx && wx.getFileSystemManager && wx.getFileSystemManager();
    const pending = new Map();
    let serial = 0;
    let waiting = null;
    let sceneLoader = null;
    let bridgeVersion = 1;
    let running = null;
    let sceneQueue = Promise.resolve();
    const sceneRequests = new Map();
    const preparationRequests = new Map();
    const mountRequests = new Map();
    const HASH = /^[0-9a-f]{64}$/;
    const ID = /^[a-z][a-z0-9_-]{0,47}$/;

    function canonical(value) {
        if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
        if (value && typeof value === "object") {
            return (
                "{" +
                Object.keys(value)
                    .sort()
                    .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
                    .join(",") +
                "}"
            );
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
    function privateHttp(url) {
        if (typeof url !== "string") return false;
        const match =
            /^http:\/\/((?:10|127)(?:\.\d{1,3}){3}|(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2})(?::(\d{1,5}))?\/[^?#\s]*$/.exec(
                url
            );
        if (!match || match[1].split(".").some((part) => Number(part) > 255)) return false;
        return !match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535);
    }
    function compatibleVersion(packVersion, engineVersion, localDev) {
        if (packVersion === engineVersion) return true;
        if (
            !localDev ||
            !/^\d+\.\d+\.\d+$/.test(packVersion) ||
            !/^\d+\.\d+\.\d+$/.test(engineVersion)
        )
            return false;
        const pack = packVersion.split(".").map(Number),
            engine = engineVersion.split(".").map(Number);
        // Godot accepts older patch-level PCKs within the same major/minor line.
        return pack[0] === engine[0] && pack[1] === engine[1] && pack[2] <= engine[2];
    }
    function validate(manifest, engineVersion, localDev = false) {
        if (
            !manifest ||
            ![2, 3, 4].includes(manifest.schema) ||
            typeof manifest.project_id !== "string" ||
            !manifest.project_id ||
            !compatibleVersion(manifest.engine_version, engineVersion, localDev) ||
            !HASH.test(manifest.release_id) ||
            manifest.bootstrap !== "bootstrap" ||
            !manifest.packs ||
            Array.isArray(manifest.packs) ||
            !manifest.scene_to_pack ||
            Array.isArray(manifest.scene_to_pack) ||
            (manifest.schema === 2
                ? typeof manifest.entry_scene !== "string"
                : typeof manifest.project_scene !== "string")
        )
            throw new Error("Invalid scene manifest/version");
        const content = Object.assign({}, manifest);
        delete content.release_id;
        if (hashText(canonical(content)) !== manifest.release_id)
            throw new Error("Manifest content hash mismatch");
        const owners = new Map();
        for (const [id, pack] of Object.entries(manifest.packs)) {
            if (
                !ID.test(id) ||
                !pack ||
                pack.compression !== "br" ||
                !HASH.test(pack.br_sha256) ||
                !HASH.test(pack.pck_sha256) ||
                !Number.isSafeInteger(pack.br_size) ||
                pack.br_size <= 0 ||
                !Number.isSafeInteger(pack.pck_size) ||
                pack.pck_size < 20 ||
                pack.url !== `packs/${id}-${pack.br_sha256}.pck.br` ||
                !Array.isArray(pack.depends) ||
                !Array.isArray(pack.files)
            )
                throw new Error("Invalid pack: " + id);
            for (const file of pack.files) {
                if (
                    typeof file !== "string" ||
                    !file.startsWith("res://") ||
                    file.split("/").includes("..") ||
                    owners.has(file)
                ) {
                    throw new Error("Invalid/duplicate resource: " + file);
                }
                owners.set(file, id);
            }
            for (const dep of pack.depends) {
                if (!Object.prototype.hasOwnProperty.call(manifest.packs, dep) || dep === id)
                    throw new Error("Unknown dependency: " + dep);
            }
        }
        for (const [scene, id] of Object.entries(manifest.scene_to_pack)) {
            if (owners.get(scene) !== id || !/\.(tscn|scn)$/.test(scene))
                throw new Error("Invalid scene mapping: " + scene);
        }
        const projectScene = manifest.schema === 2 ? manifest.entry_scene : manifest.project_scene;
        if (manifest.schema === 4 && !["direct", "godot_loading"].includes(manifest.startup_mode))
            throw new Error("Invalid startup mode");
        if (loadingMode(manifest) && !projectScene)
            throw new Error("Godot loading mode requires a project loading scene");
        if (manifest.scene_override !== undefined && typeof manifest.scene_override !== "boolean")
            throw new Error("Invalid scene override capability");
        if (
            !manifest.packs.bootstrap ||
            (projectScene &&
                !Object.prototype.hasOwnProperty.call(manifest.scene_to_pack, projectScene)) ||
            (manifest.schema === 2 && !projectScene)
        )
            throw new Error("Missing project scene/bootstrap");
        for (const [file, id] of owners) {
            if (/\.(tscn|scn)$/.test(file) && manifest.scene_to_pack[file] !== id)
                throw new Error("Missing scene mapping: " + file);
        }
        order(manifest, Object.keys(manifest.packs)); // Validate even unreachable cycles.
        return manifest;
    }
    function order(manifest, roots) {
        const done = new Set(),
            active = new Set(),
            result = [];
        function visit(id) {
            if (active.has(id)) throw new Error("Pack dependency cycle: " + id);
            if (done.has(id)) return;
            if (!manifest.packs[id]) throw new Error("Unknown pack: " + id);
            active.add(id);
            manifest.packs[id].depends.forEach(visit);
            active.delete(id);
            done.add(id);
            result.push(id);
        }
        roots.forEach(visit);
        return result;
    }
    function io(method, options) {
        return new Promise((resolve, reject) => {
            if (!fs || !fs[method])
                return reject(new Error("WeChat filesystem unavailable: " + method));
            fs[method](
                Object.assign({}, options, {
                    success: resolve,
                    fail: (e) => reject(new Error(e.errMsg || method + " failed")),
                })
            );
        });
    }
    function loadingMode(manifest) {
        return manifest.schema === 4 && manifest.startup_mode === "godot_loading";
    }
    function notify(callback, stage, id, percent, completed = percent, total = 100) {
        if (callback) callback({ stage, pack: id, percent, completed, total });
    }
    function request(url) {
        return new Promise((resolve, reject) => {
            wx.request({
                url,
                method: "GET",
                dataType: "text",
                responseType: "text",
                timeout: 30000,
                header: { "Cache-Control": "no-cache" },
                success: (r) => {
                    if (r.statusCode !== 200)
                        return reject(new Error("Manifest HTTP " + r.statusCode));
                    try {
                        resolve(typeof r.data === "string" ? JSON.parse(r.data) : r.data);
                    } catch (e) {
                        reject(e);
                    }
                },
                fail: (e) => reject(new Error(e.errMsg || "Manifest request failed")),
            });
        });
    }
    function download(url, callback, id) {
        return new Promise((resolve, reject) => {
            const task = wx.downloadFile({
                url,
                timeout: 60000,
                success: (r) =>
                    r.statusCode === 200 && r.tempFilePath
                        ? resolve(r.tempFilePath)
                        : reject(new Error(id + ": HTTP " + r.statusCode)),
                fail: (e) => reject(new Error(id + ": " + (e.errMsg || "Download failed"))),
            });
            if (task && task.onProgressUpdate)
                task.onProgressUpdate((r) =>
                    notify(
                        callback,
                        "download",
                        id,
                        r.progress,
                        Number(r.totalBytesWritten) || 0,
                        Number(r.totalBytesExpectedToWrite) || 0
                    )
                );
        });
    }
    function cacheFile(session, id) {
        const m = session.manifest;
        return (
            session.directory +
            "/" +
            hashText(m.project_id + "@" + m.engine_version).slice(0, 16) +
            "-" +
            m.packs[id].br_sha256 +
            ".br"
        );
    }
    function checkCompressed(data, pack) {
        if (
            (data.byteLength === undefined ? data.length : data.byteLength) !== pack.br_size ||
            root.remotePack.sha256(data) !== pack.br_sha256
        ) {
            throw new Error("Compressed pack hash/size mismatch");
        }
    }
    async function compressed(session, id, offline, callback) {
        try {
            await getCompressed(session, id, offline, callback);
        } catch (error) {
            throw new Error(id + ": " + error.message);
        }
    }
    async function getCompressed(session, id, offline, callback) {
        const destination = cacheFile(session, id),
            pack = session.manifest.packs[id];
        try {
            const data = (await io("readFile", { filePath: destination })).data;
            notify(callback, "verify", id, 0);
            checkCompressed(data, pack);
            notify(callback, "verify", id, 100);
            notify(callback, "download", id, 100, pack.br_size, pack.br_size);
            return;
        } catch (error) {
            if (offline) throw new Error("cached pack unavailable: " + error.message);
        }
        if (!pending.has(destination)) {
            pending.set(
                destination,
                (async () => {
                    const path = await download(session.base + pack.url, callback, id);
                    const temporary = destination + ".partial-" + ++serial;
                    try {
                        const data = (await io("readFile", { filePath: path })).data;
                        notify(callback, "verify", id, 0);
                        checkCompressed(data, pack);
                        notify(callback, "verify", id, 100);
                        notify(callback, "download", id, 100, pack.br_size, pack.br_size);
                        await io("copyFile", { srcPath: path, destPath: temporary });
                        // Same name means same immutable content; a damaged existing copy may be removed.
                        await io("unlink", { filePath: destination }).catch(() => {});
                        await io("rename", { oldPath: temporary, newPath: destination });
                    } finally {
                        await io("unlink", { filePath: temporary }).catch(() => {});
                        await io("unlink", { filePath: path }).catch(() => {});
                    }
                })().finally(() => pending.delete(destination))
            );
        }
        await pending.get(destination);
    }
    async function decode(session, id, decoder, callback) {
        notify(callback, "decode", id, 0);
        try {
            const data = (await io("readFile", { filePath: cacheFile(session, id) })).data;
            const bytes = root.remotePack.decodeCompressed(
                data,
                Object.assign(
                    { engine_version: session.manifest.engine_version },
                    session.manifest.packs[id]
                ),
                decoder
            );
            notify(callback, "decode", id, 100);
            return bytes;
        } catch (error) {
            throw new Error(id + ": " + error.message);
        }
    }
    function scenePacks(manifest, scene) {
        if (
            typeof scene !== "string" ||
            !Object.prototype.hasOwnProperty.call(manifest.scene_to_pack, scene)
        ) {
            throw new Error("Scene is not in this release: " + scene);
        }
        return order(manifest, ["bootstrap", manifest.scene_to_pack[scene]]);
    }
    function chooseScene(manifest, requested) {
        if (loadingMode(manifest) && requested)
            throw new Error(
                "Godot loading mode selects its target in GDScript; remove the host scene override"
            );
        const scene =
            requested || (manifest.schema === 2 ? manifest.entry_scene : manifest.project_scene);
        if (!scene)
            throw new Error("No engine default scene; specify scene in the runtime configuration");
        scenePacks(manifest, scene);
        if (
            requested &&
            requested !== (manifest.project_scene || manifest.entry_scene) &&
            manifest.scene_override === false
        ) {
            throw new Error(
                "Project settings disable runtime startup overrides; enable project settings overrides or switch scenes after startup"
            );
        }
        return scene;
    }
    function startupOverride(session) {
        return utf8("[application]\nrun/main_scene=" + JSON.stringify(session.scene) + "\n");
    }
    async function obtainPacks(session, ids, decoder, offline, callback, validateDecoded = true) {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(3, ids.length) }, async () => {
            while (cursor < ids.length) {
                const id = ids[cursor++];
                await compressed(session, id, offline, callback);
            }
        });
        // Wait for every in-flight write before considering a fallback/cleanup.
        const outcomes = await Promise.all(
            workers.map((p) =>
                p.then(
                    () => null,
                    (e) => e
                )
            )
        );
        const error = outcomes.find(Boolean);
        if (error) throw error;
        if (validateDecoded) for (const id of ids) await decode(session, id, decoder, callback);
    }
    async function obtain(session, decoder, offline, callback, requested) {
        session.scene = chooseScene(session.manifest, requested);
        session.ids = scenePacks(session.manifest, session.scene);
        await obtainPacks(session, session.ids, decoder, offline, callback);
        return session;
    }
    function successfulRecord(value, engineVersion, localDev, requested) {
        const manifest = validate(value.manifest || value, engineVersion, localDev);
        const confirmed_scene = value.manifest
            ? value.confirmed_scene
            : chooseScene(manifest, requested);
        scenePacks(manifest, confirmed_scene);
        if (loadingMode(manifest) && confirmed_scene === manifest.project_scene)
            throw new Error("Loading page is not a confirmed game scene");
        return { record_schema: 1, manifest, confirmed_scene };
    }
    // 离线完整性必须覆盖加载页和已确认关卡；仅有首屏缓存不足以回退。
    async function verifyPrevious(record, directory, base, decoder, callback) {
        const session = { manifest: record.manifest, directory, base };
        const ids = new Set(scenePacks(record.manifest, record.confirmed_scene));
        const start = record.manifest.entry_scene || record.manifest.project_scene;
        if (start) scenePacks(record.manifest, start).forEach((id) => ids.add(id));
        await obtainPacks(session, [...ids], decoder, true, callback);
    }
    // 每次启动固定一份清单；引擎启动前的失败才允许整体切换到旧清单。
    async function prepare(config, decoder, callback) {
        if (
            !config ||
            !(
                https(config.manifest_url) ||
                (config.local_dev === true && privateHttp(config.manifest_url))
            ) ||
            !/^\d+\.\d+\.\d+$/.test(config.engine_version)
        )
            throw new Error("Invalid manifest startup config");
        const directory =
            wx.env.USER_DATA_PATH + "/scene-packs-" + hashText(config.manifest_url).slice(0, 24);
        await io("mkdir", { dirPath: directory, recursive: true }).catch(() => {});
        let previousRecord = null;
        try {
            const saved = await io("readFile", {
                filePath: directory + "/successful.json",
                encoding: "utf8",
            });
            previousRecord = successfulRecord(
                JSON.parse(saved.data),
                config.engine_version,
                config.local_dev === true,
                config.scene
            );
        } catch (_) {
            /* No trusted successful release yet. */
        }
        const previous = previousRecord && previousRecord.manifest;
        const base = config.manifest_url.slice(0, config.manifest_url.lastIndexOf("/") + 1);
        const fallback = async () => {
            if (!previousRecord) throw new Error("No previous successful release");
            await verifyPrevious(previousRecord, directory, base, decoder, callback);
            return obtain(
                {
                    manifest: previous,
                    previous,
                    previousRecord,
                    directory,
                    base,
                    fallback: true,
                    confirmedScene: previousRecord.confirmed_scene,
                },
                decoder,
                true,
                callback,
                config.scene
            );
        };
        let rollback = null;
        try {
            rollback = JSON.parse(
                (await io("readFile", { filePath: directory + "/rollback.json", encoding: "utf8" }))
                    .data
            );
        } catch (_) {
            /* Normal launch. */
        }
        if (rollback) {
            await io("unlink", { filePath: directory + "/rollback.json" });
            if (!previous || rollback.release_id !== previous.release_id)
                throw new Error("Previous release changed; restart normally");
            return fallback();
        }
        try {
            notify(callback, "manifest", "", 0);
            const manifest = validate(
                await request(config.manifest_url),
                config.engine_version,
                config.local_dev === true
            );
            if (previous && manifest.project_id !== previous.project_id)
                throw new Error("Manifest project identity changed");
            return await obtain(
                { manifest, previous, previousRecord, directory, base, fallback: false },
                decoder,
                false,
                callback,
                config.scene
            );
        } catch (error) {
            if (!previous) throw error;
            console.warn("Using complete previous scene-pack release", error);
            return fallback();
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
        return {
            main: paths.bootstrap,
            extra: session.ids.filter((id) => id !== "bootstrap").map((id) => paths[id]),
        };
    }
    // 成功指针先原子替换，再回收旧包；失败时旧记录与旧缓存仍可用。
    async function commit(session, confirmedScene = session.scene) {
        scenePacks(session.manifest, confirmedScene);
        if (loadingMode(session.manifest) && confirmedScene === session.manifest.project_scene)
            throw new Error("Loading page cannot commit a successful release");
        const temporary = session.directory + "/successful.partial-" + ++serial;
        try {
            await io("writeFile", {
                filePath: temporary,
                data: canonical({
                    record_schema: 1,
                    manifest: session.manifest,
                    confirmed_scene: confirmedScene,
                }),
                encoding: "utf8",
            });
            // Atomic replacement; do not unlink the previous successful pointer on failure.
            await io("rename", {
                oldPath: temporary,
                newPath: session.directory + "/successful.json",
            });
        } finally {
            await io("unlink", { filePath: temporary }).catch(() => {});
        }
        // Retain cached scenes from this release even when this launch did not visit them.
        const keep = new Set(
            Object.keys(session.manifest.packs).map((id) => cacheFile(session, id).split("/").pop())
        );
        try {
            const listing = await io("readdir", { dirPath: session.directory });
            for (const file of listing.files) {
                if (/^[0-9a-f]{16}-[0-9a-f]{64}\.br$/.test(file) && !keep.has(file)) {
                    await io("unlink", { filePath: session.directory + "/" + file }).catch(
                        () => {}
                    );
                }
            }
        } catch (_) {
            /* Cache reclamation is best effort after the pointer commits. */
        }
    }
    function waitForScene(scene, timeout = 60000) {
        if (waiting) throw new Error("A scene startup is already pending");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiting = null;
                reject(new Error("Scene startup timed out; restart to retry"));
            }, timeout);
            waiting = { scene, resolve, reject, timer };
        });
    }
    function cancelWait(error) {
        if (!waiting) return;
        clearTimeout(waiting.timer);
        waiting.reject(error);
        waiting = null;
    }
    // ready 只等待加载页首帧，不能等待业务确认，否则会阻塞关卡自己的下载。
    function activate(session, decoder, copy, ready = Promise.resolve()) {
        running = {
            session,
            decoder,
            copy,
            ready,
            installed: new Set(session.ids),
            failed: false,
            confirmed: false,
            commitPromise: null,
        };
    }
    const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
    function bridge(command, scene, paths) {
        if (!sceneLoader)
            return Promise.reject(
                new Error("Scene loading bridge is unavailable; update the exported bootstrap pack")
            );
        return new Promise((resolve, reject) => {
            const id = ++serial;
            const timer = setTimeout(() => {
                mountRequests.delete(id);
                reject(new Error("Scene operation timed out; restart to retry"));
            }, 60000);
            mountRequests.set(id, { scene, resolve, reject, timer });
            try {
                sceneLoader(JSON.stringify({ id, command, scene, packs: paths }));
            } catch (error) {
                clearTimeout(timer);
                mountRequests.delete(id);
                reject(error);
            }
        });
    }
    function enqueue(operation) {
        const active = running;
        const task = sceneQueue.then(async () => {
            if (!active || active !== running)
                throw new Error("Start a manifest session before loading a scene");
            await active.ready;
            if (active.failed) throw new Error("Scene engine state is uncertain; restart to retry");
            if (!sceneLoader)
                throw new Error(
                    "Scene loading bridge is unavailable; update the exported bootstrap pack"
                );
            return operation(active);
        });
        sceneQueue = task.catch(() => {});
        return task;
    }
    async function prepareInSession(active, scene, callback, legacyLoad = false) {
        if (bridgeVersion < 2 && !legacyLoad)
            throw new Error("Update the bootstrap pack to use prepare_scene");
        const { session, decoder, copy } = active;
        const ids = scenePacks(session.manifest, scene).filter((id) => !active.installed.has(id));
        const downloaded = new Map(),
            verified = new Set();
        const totalBytes = ids.reduce((sum, id) => sum + session.manifest.packs[id].br_size, 0);
        const progress = (event) => {
            if (event.stage === "download") {
                if (event.total > 0)
                    downloaded.set(
                        event.pack,
                        Math.min(event.completed, session.manifest.packs[event.pack].br_size)
                    );
                const done = [...downloaded.values()].reduce((a, b) => a + b, 0);
                notify(
                    callback,
                    "download",
                    event.pack,
                    totalBytes ? (done / totalBytes) * 100 : 0,
                    done,
                    totalBytes
                );
            } else if (event.stage === "verify") {
                if (event.percent === 100) verified.add(event.pack);
                notify(
                    callback,
                    "verify",
                    event.pack,
                    ids.length ? (verified.size / ids.length) * 100 : 100,
                    verified.size,
                    ids.length
                );
            }
        };
        await obtainPacks(session, ids, decoder, session.fallback, progress, false);
        const paths = [];
        for (const id of ids) {
            notify(
                callback,
                "decode",
                id,
                ids.length ? (paths.length / ids.length) * 100 : 100,
                paths.length,
                ids.length
            );
            await yieldFrame();
            const path = "/scene-packs/" + id + ".pck";
            // One decoded payload at a time; only the engine's virtual FS retains it.
            copy(path, await decode(session, id, decoder));
            paths.push(path);
            notify(
                callback,
                "decode",
                id,
                (paths.length / ids.length) * 100,
                paths.length,
                ids.length
            );
            await yieldFrame();
        }
        if (bridgeVersion >= 2) {
            for (let index = 0; index < paths.length; index++) {
                const id = ids[index];
                notify(callback, "mount", id, (index / paths.length) * 100, index, paths.length);
                await yieldFrame();
                try {
                    await bridge("prepare", scene, [paths[index]]);
                } catch (error) {
                    active.failed = true;
                    throw new Error(id + ": " + error.message);
                }
                active.installed.add(id);
                notify(
                    callback,
                    "mount",
                    id,
                    ((index + 1) / paths.length) * 100,
                    index + 1,
                    paths.length
                );
            }
        } else if (legacyLoad) {
            try {
                await bridge("load", scene, paths);
            } catch (error) {
                active.failed = true;
                throw error;
            }
            ids.forEach((id) => active.installed.add(id));
        }
        return scene;
    }
    // 外部请求共享下载和挂载任务，各监听者收到同一进度；不负责切换场景。
    function prepareScene(scene, callback) {
        const existing = preparationRequests.get(scene);
        if (existing) {
            if (callback) existing.listeners.add(callback);
            return existing.promise;
        }
        const item = { listeners: new Set(callback ? [callback] : []) };
        item.promise = enqueue((active) =>
            prepareInSession(active, scene, (event) =>
                item.listeners.forEach((listener) => listener(event))
            )
        ).finally(() => preparationRequests.delete(scene));
        preparationRequests.set(scene, item);
        return item.promise;
    }
    function loadScene(scene, callback) {
        if (sceneRequests.has(scene)) return sceneRequests.get(scene);
        const task = enqueue(async (active) => {
            await prepareInSession(active, scene, callback, true);
            notify(callback, "start", scene, 0);
            try {
                if (bridgeVersion >= 2) await bridge("load", scene, []);
            } catch (error) {
                active.failed = true;
                throw error;
            }
            active.session.scene = scene;
            notify(callback, "start", scene, 100);
            return scene;
        });
        const shared = task.finally(() => sceneRequests.delete(scene));
        sceneRequests.set(scene, shared);
        return shared;
    }
    function emit(event) {
        if (sceneLoader) sceneLoader(JSON.stringify(event));
    }
    // GDScript 已核验当前场景与预热状态；这里核验挂载集合并提交一次版本。
    function confirmScene(scene) {
        const active = running;
        if (!active || active.failed)
            return Promise.reject(new Error("Engine session is unavailable"));
        if (active.confirmed) return Promise.resolve();
        if (active.commitPromise) return active.commitPromise;
        active.commitPromise = (async () => {
            await active.ready;
            if (!scenePacks(active.session.manifest, scene).every((id) => active.installed.has(id)))
                throw new Error("Scene packages are not mounted");
            await commit(active.session, scene);
            active.session.scene = scene;
            active.confirmed = true;
        })().finally(() => {
            active.commitPromise = null;
        });
        return active.commitPromise;
    }
    // 运行中只写下一次启动的回退标记，绝不将旧包挂载到当前引擎。
    async function restartPrevious() {
        const active = running;
        if (!active || !active.session.previousRecord || active.confirmed)
            throw new Error("No previous successful release available for this launch");
        const { session, decoder } = active;
        await verifyPrevious(session.previousRecord, session.directory, session.base, decoder);
        if (!wx.restartMiniProgram) throw new Error("Restart is unavailable in this host");
        const file = session.directory + "/rollback.json";
        const temporary = file + ".partial-" + ++serial;
        try {
            await io("writeFile", {
                filePath: temporary,
                data: canonical({ release_id: session.previous.release_id }),
                encoding: "utf8",
            });
            await io("rename", { oldPath: temporary, newPath: file });
        } finally {
            await io("unlink", { filePath: temporary }).catch(() => {});
        }
        try {
            await new Promise((resolve, reject) =>
                wx.restartMiniProgram({
                    success: resolve,
                    fail: (error) => reject(new Error(error.errMsg || "Restart failed")),
                })
            );
        } catch (error) {
            await io("unlink", { filePath: file }).catch(() => {});
            throw error;
        }
    }
    root.manifestPacks = {
        canonical,
        hashText,
        validate,
        order,
        scenePacks,
        prepare,
        install,
        commit,
        waitForScene,
        cancelWait,
        activate,
        loadScene,
        prepareScene,
        confirmScene,
        restartPrevious,
        loadingMode,
        startupOverride,
        registerSceneLoader(callback, version = 1) {
            sceneLoader = callback;
            bridgeVersion = version;
        },
        rollbackScene() {
            return running && running.session.fallback ? running.session.confirmedScene || "" : "";
        },
        canRollback() {
            return !!(running && running.session.previousRecord && !running.confirmed);
        },
        sceneLoaded(id, scene, error) {
            const request = mountRequests.get(id);
            if (!request) return;
            clearTimeout(request.timer);
            mountRequests.delete(id);
            if (error || request.scene !== scene)
                request.reject(new Error(error || "Loaded scene does not match request"));
            else request.resolve();
        },
        requestPrepare(scene, requestId) {
            prepareScene(scene, (event) =>
                emit(Object.assign({ event: "progress", request_id: requestId }, event))
            ).then(
                () => emit({ event: "packs_ready", request_id: requestId, scene }),
                (error) =>
                    emit({
                        event: "failed",
                        request_id: requestId,
                        code: running && running.failed ? "engine" : "resources",
                        error: error.message,
                        retryable: !!running && !running.failed,
                    })
            );
        },
        requestConfirm(scene) {
            confirmScene(scene).then(
                () => emit({ event: "confirmed", scene }),
                (error) => emit({ event: "confirm_failed", scene, error: error.message })
            );
        },
        requestRollback() {
            restartPrevious().catch((error) =>
                emit({ event: "rollback_failed", error: error.message })
            );
        },
        requestScene(scene) {
            loadScene(scene).then(
                () => emit({ event: "loaded", scene }),
                (error) => emit({ event: "error", scene, error: error.message })
            );
        },
        sceneReady(scene) {
            if (waiting && waiting.scene === scene) {
                clearTimeout(waiting.timer);
                waiting.resolve();
                waiting = null;
            }
        },
    };
})(typeof globalThis !== "undefined" ? globalThis : this);
