(function (global) {
    const root = global;
    const windowObject = root.window || root;
    const gameGlobal = root.GameGlobal || (root.GameGlobal = {});
    const wxApi = root.wx;

    const nowStart = Date.now();
    function nowPolyfill() {
        return Date.now() - nowStart;
    }

    root.nowPolyfill = nowPolyfill;
    windowObject.nowPolyfill = nowPolyfill;
    gameGlobal.nowPolyfill = nowPolyfill;

    const fsUtils = {
        localFetch(filePath) {
            return new Promise(function (resolve, reject) {
                if (!wxApi || !wxApi.getFileSystemManager) {
                    reject(new Error("wx.getFileSystemManager is not available"));
                    return;
                }

                wxApi.getFileSystemManager().readFile({
                    filePath: filePath,
                    success: function (res) {
                        resolve(res.data);
                    },
                    fail: function (err) {
                        reject(new Error(err && err.errMsg ? err.errMsg : "readFile failed"));
                    },
                });
            });
        },

        loadSubpackage(name, onProgress, onComplete) {
            if (!wxApi || typeof wxApi.loadSubpackage !== "function") {
                const error = new Error("wx.loadSubpackage is not available");
                if (typeof onComplete === "function") {
                    onComplete(error);
                }
                return null;
            }

            const task = wxApi.loadSubpackage({
                name: name,
                success: function () {
                    if (typeof onComplete === "function") {
                        onComplete(null);
                    }
                },
                fail: function (res) {
                    const message = res && res.errMsg ? res.errMsg : "loadSubpackage failed";
                    if (typeof onComplete === "function") {
                        onComplete(new Error(message));
                    }
                },
            });

            if (task && typeof onProgress === "function" && typeof task.onProgressUpdate === "function") {
                task.onProgressUpdate(onProgress);
            }

            return task;
        },
    };

    root.fsUtils = fsUtils;
    windowObject.fsUtils = fsUtils;
    gameGlobal.fsUtils = fsUtils;

    const globalAdapter = root.__globalAdapter || {};
    root.__globalAdapter = globalAdapter;
    windowObject.__globalAdapter = globalAdapter;

    [
        "showKeyboard",
        "hideKeyboard",
        "updateKeyboard",
        "onKeyboardInput",
        "onKeyboardConfirm",
        "onKeyboardComplete",
        "offKeyboardInput",
        "offKeyboardConfirm",
        "offKeyboardComplete",
    ].forEach(function (method) {
        if (wxApi && typeof wxApi[method] === "function") {
            globalAdapter[method] = wxApi[method].bind(wxApi);
        } else if (typeof globalAdapter[method] !== "function") {
            globalAdapter[method] = function () {};
        }
    });

    const WEBAudio = {
        audioContext: null,
    };

    function initAudio() {
        if (WEBAudio.audioContext || !wxApi || typeof wxApi.createWebAudioContext !== "function") {
            return WEBAudio.audioContext;
        }

        WEBAudio.audioContext = wxApi.createWebAudioContext();

        if (typeof wxApi.onHide === "function") {
            wxApi.onHide(function () {
                if (WEBAudio.audioContext && typeof WEBAudio.audioContext.suspend === "function") {
                    WEBAudio.audioContext.suspend();
                }
            });
        }

        if (typeof wxApi.onShow === "function") {
            wxApi.onShow(function () {
                if (WEBAudio.audioContext && typeof WEBAudio.audioContext.resume === "function") {
                    WEBAudio.audioContext.resume();
                }
            });
        }

        return WEBAudio.audioContext;
    }

    const audio = {
        WEBAudio: WEBAudio,
        init: initAudio,
    };

    initAudio();

    function getCanvas() {
        return root.canvas || gameGlobal.canvas || windowObject.canvas;
    }

    function runEngine(executable, packPath, bytes) {
        const engine = new root.Engine({ canvas: getCanvas() });
        gameGlobal.GODOTSDK.engine = engine;
        const init = engine.init(executable);
        const preload = bytes ? engine.preloadFile(bytes, packPath) : engine.preloadFile(packPath);
        return Promise.all([init, preload]).then(function () {
            return engine.start({
                args: ["--main-pack", packPath],
                onProgress: function (current, total) {
                    console.log("Loaded " + current + " of " + total + " bytes");
                },
            });
        });
    }

    async function startGame(executable, pack, decodeBr) {
        const loader = gameGlobal.godotLoader;

        if (!root.Engine) {
            throw new Error("Engine is not available");
        }

        if (typeof root.Engine.isWebGLAvailable === "function" && !root.Engine.isWebGLAvailable()) {
            if (loader) {
                loader.currentText = "WebGL not available!";
            }
            throw new Error("WebGL not available");
        }
        const config = typeof pack === "string" ? { mode: "local", path: pack } : pack;
        try {
            if (config && config.mode === "remote") {
                const remote = gameGlobal.remotePack;
                if (!remote) throw new Error("Remote PCK runtime is not available");
                if (loader && typeof loader.updateProgress === "function") {
                    loader.updateProgress(0.5, "正在下载游戏资源");
                }
                let candidate = await remote.prepare(config, decodeBr, function (percent) {
                    if (loader && typeof loader.updateProgress === "function") {
                        loader.updateProgress(0.5 + Math.max(0, Math.min(100, percent)) * 0.004,
                            "正在下载游戏资源");
                    }
                });
                if (loader && typeof loader.updateProgress === "function") {
                    loader.updateProgress(0.92, "正在启动游戏");
                }
                try {
                    await runEngine(executable, candidate.config.path, candidate.bytes);
                } catch (error) {
                    if (candidate.fromCache) throw error;
                    console.warn("New PCK failed to start; retrying previous successful version", error);
                    candidate = await remote.fallback(config, decodeBr);
                    await runEngine(executable, candidate.config.path, candidate.bytes);
                }
                if (!candidate.fromCache) {
                    try {
                        await remote.commit(candidate);
                    } catch (error) {
                        console.warn("PCK started but could not be cached", error);
                    }
                }
            } else if (config && config.mode === "bundled_br") {
                if (config.path !== "/engine/demo-pck.bin" || config.file !== "engine/demo-pck.br" ||
                        !gameGlobal.remotePack || typeof decodeBr !== "function") {
                    throw new Error("Invalid bundled Brotli PCK config");
                }
                if (loader && typeof loader.updateProgress === "function") {
                    loader.updateProgress(0.5, "正在解压游戏资源");
                }
                const compressed = await fsUtils.localFetch(config.file);
                const bytes = gameGlobal.remotePack.decodeCompressed(compressed, config, decodeBr);
                await runEngine(executable, config.path, bytes);
            } else if (config && config.mode === "local" && typeof config.path === "string") {
                if (loader && loader.config && loader.config.textConfig) {
                    loader.currentText = loader.config.textConfig.compilingText;
                }
                await runEngine(executable, config.path);
            } else {
                throw new Error("Invalid PCK startup config");
            }
            if (loader && loader.config && loader.config.textConfig) {
                loader.currentText = loader.config.textConfig.completeText;
            }
            if (loader && typeof loader.updateProgress === "function") {
                loader.updateProgress(1);
            }
            if (loader && typeof loader.cleanup === "function") {
                loader.cleanup();
            }
        } catch (error) {
            if (loader) {
                loader.currentText = "游戏资源加载失败，请检查网络或控制台";
                if (typeof loader.render === "function") loader.render();
            }
            throw error;
        }
    }

    const GODOTSDK = gameGlobal.GODOTSDK || {};
    GODOTSDK.audio = audio;
    GODOTSDK.startGame = startGame;
    GODOTSDK.copy_to_fs = function (path, buffer) {
        const engine = GODOTSDK.engine;
        if (!engine || !engine.rtenv || typeof engine.rtenv.copyToFS !== "function") {
            throw new Error("GODOTSDK.engine.rtenv.copyToFS is not available");
        }
        engine.rtenv.copyToFS(path, buffer);
    };
    GODOTSDK.load_pack = function (subpackage, pck, progressCall, onTaskDone) {
        fsUtils.loadSubpackage(subpackage, progressCall, function (error) {
            if (error) {
                if (typeof onTaskDone === "function") {
                    onTaskDone(error);
                }
                return;
            }

            const engine = GODOTSDK.engine;
            if (!engine) {
                if (typeof onTaskDone === "function") {
                    onTaskDone(new Error("GODOTSDK.engine is not available"));
                }
                return;
            }

            engine.preloadFile(pck).then(function () {
                engine.preloader.preloadedFiles.forEach(function (file) {
                    engine.rtenv.copyToFS(file.path, file.buffer);
                });
                engine.preloader.preloadedFiles.length = 0;

                if (typeof progressCall === "function") {
                    progressCall(100);
                }
                if (typeof onTaskDone === "function") {
                    onTaskDone(null);
                }
            }).catch(function (loadError) {
                if (typeof onTaskDone === "function") {
                    onTaskDone(loadError);
                }
            });
        });
    };
    gameGlobal.GODOTSDK = GODOTSDK;

    if (gameGlobal.WXWebAssembly) {
        root.WebAssembly = gameGlobal.WXWebAssembly;
        windowObject.WebAssembly = gameGlobal.WXWebAssembly;
        gameGlobal.WebAssembly = gameGlobal.WXWebAssembly;
        gameGlobal.CCWebAssembly = gameGlobal.WXWebAssembly;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
