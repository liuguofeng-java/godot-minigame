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

    function startGame(executable, pack) {
        const loader = gameGlobal.godotLoader;

        if (!root.Engine) {
            return Promise.reject(new Error("Engine is not available"));
        }

        if (typeof root.Engine.isWebGLAvailable === "function" && !root.Engine.isWebGLAvailable()) {
            if (loader) {
                loader.currentText = "WebGL not available!";
            }
            return Promise.reject(new Error("WebGL not available"));
        }

        if (loader && loader.config && loader.config.textConfig) {
            loader.currentText = loader.config.textConfig.compilingText;
        }

        const engine = new root.Engine({ canvas: getCanvas() });
        gameGlobal.GODOTSDK.engine = engine;

        return Promise.all([engine.init(executable), engine.preloadFile(pack)])
            .then(function () {
                if (loader && loader.config && loader.config.textConfig) {
                    loader.currentText = loader.config.textConfig.initText;
                }

                if (loader && typeof loader.cleanup === "function") {
                    loader.cleanup();
                }

                return engine.start({
                    args: ["--main-pack", pack],
                    onProgress: function (current, total) {
                        console.log("Loaded " + current + " of " + total + " bytes");
                    },
                });
            })
            .then(function () {
                if (loader && loader.config && loader.config.textConfig) {
                    loader.currentText = loader.config.textConfig.completeText;
                }
            });
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
