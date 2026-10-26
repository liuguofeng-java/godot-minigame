(function (global) {
    "use strict";

    const gameGlobal = global.GameGlobal || (global.GameGlobal = {});
    const wxApi = global.wx;
    const fs = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
    const userDataPath = wxApi && wxApi.env && wxApi.env.USER_DATA_PATH;
    const lastGoodPath = userDataPath ? userDataPath + "/godot-pck-last-good.json" : null;
    const VIRTUAL_PATH = "/engine/demo-pck.bin";
    const SHA256_K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    function bytesOf(value) {
        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        throw new Error("Expected binary file data");
    }

    function sha256(input) {
        const bytes = bytesOf(input);
        const state = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ];
        const words = new Int32Array(64);
        function rotate(value, bits) {
            return (value >>> bits) | (value << (32 - bits));
        }
        function block(data, offset) {
            for (let i = 0; i < 16; i++) {
                const at = offset + i * 4;
                words[i] = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
            }
            for (let i = 16; i < 64; i++) {
                const x = words[i - 15];
                const y = words[i - 2];
                const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
                const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
                words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
            }
            let [a, b, c, d, e, f, g, h] = state;
            for (let i = 0; i < 64; i++) {
                const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
                const choose = (e & f) ^ (~e & g);
                const t1 = (h + s1 + choose + SHA256_K[i] + words[i]) | 0;
                const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
                const majority = (a & b) ^ (a & c) ^ (b & c);
                const t2 = (s0 + majority) | 0;
                h = g; g = f; f = e; e = (d + t1) | 0;
                d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            state[0] = (state[0] + a) | 0;
            state[1] = (state[1] + b) | 0;
            state[2] = (state[2] + c) | 0;
            state[3] = (state[3] + d) | 0;
            state[4] = (state[4] + e) | 0;
            state[5] = (state[5] + f) | 0;
            state[6] = (state[6] + g) | 0;
            state[7] = (state[7] + h) | 0;
        }
        let offset = 0;
        while (offset + 64 <= bytes.length) {
            block(bytes, offset);
            offset += 64;
        }
        const tail = new Uint8Array(bytes.length - offset < 56 ? 64 : 128);
        tail.set(bytes.subarray(offset));
        tail[bytes.length - offset] = 0x80;
        const bitLength = bytes.length * 8;
        const high = Math.floor(bitLength / 0x100000000);
        const low = bitLength >>> 0;
        const end = tail.length;
        tail[end - 8] = high >>> 24; tail[end - 7] = high >>> 16;
        tail[end - 6] = high >>> 8; tail[end - 5] = high;
        tail[end - 4] = low >>> 24; tail[end - 3] = low >>> 16;
        tail[end - 2] = low >>> 8; tail[end - 1] = low;
        for (let at = 0; at < tail.length; at += 64) block(tail, at);
        return state.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
    }

    function validateConfig(config) {
        if (!config || config.schema !== 1 || config.mode !== "remote" || config.path !== VIRTUAL_PATH ||
                !/^https:\/\/[^?#]+\.pck\.br$/.test(config.url) ||
                !/^[0-9a-f]{64}$/.test(config.br_sha256) || !/^[0-9a-f]{64}$/.test(config.pck_sha256) ||
                !Number.isSafeInteger(config.br_size) || config.br_size <= 0 ||
                !Number.isSafeInteger(config.pck_size) || config.pck_size <= 0 ||
                !/^\d+\.\d+\.\d+$/.test(config.engine_version)) {
            throw new Error("Invalid remote PCK config");
        }
        return config;
    }

    function cachePath(config) {
        return userDataPath + "/godot-pck-" + config.br_sha256 + ".br";
    }

    function fsCall(method, options) {
        return new Promise(function (resolve, reject) {
            if (!fs || !userDataPath || typeof fs[method] !== "function") {
                reject(new Error("WeChat file system is not available"));
                return;
            }
            fs[method](Object.assign({}, options, {
                success: resolve,
                fail: function (error) {
                    reject(new Error(error && error.errMsg ? error.errMsg : method + " failed"));
                },
            }));
        });
    }

    async function readLastGood() {
        try {
            const result = await fsCall("readFile", { filePath: lastGoodPath, encoding: "utf8" });
            const saved = JSON.parse(result.data);
            return validateConfig(saved.config);
        } catch (error) {
            return null;
        }
    }

    function validatePck(data, config) {
        const bytes = bytesOf(data);
        if (bytes.length !== config.pck_size || bytes.length < 20 ||
                bytes[0] !== 71 || bytes[1] !== 68 || bytes[2] !== 80 || bytes[3] !== 67) {
            throw new Error("PCK size or header mismatch");
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const expected = config.engine_version.split(".").map(Number);
        if (view.getUint32(4, true) !== 4 ||
                view.getUint32(8, true) !== expected[0] ||
                view.getUint32(12, true) !== expected[1] ||
                view.getUint32(16, true) !== expected[2]) {
            throw new Error("PCK format or Godot version mismatch");
        }
        if (sha256(bytes) !== config.pck_sha256) {
            throw new Error("PCK SHA-256 mismatch");
        }
        // Engine.preloadFile indexes fileSizes by its first argument. Passing a typed
        // array would stringify every PCK byte as a property key; an ArrayBuffer does not.
        return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    function decodeCompressed(data, config, decodeBr) {
        const compressed = bytesOf(data);
        if (compressed.length !== config.br_size || sha256(compressed) !== config.br_sha256) {
            throw new Error("Brotli PCK size or SHA-256 mismatch");
        }
        if (typeof decodeBr !== "function") {
            throw new Error("Brotli decoder is not available");
        }
        return validatePck(decodeBr(new Int8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength)), config);
    }

    async function readCached(config, decodeBr) {
        const result = await fsCall("readFile", { filePath: cachePath(config) });
        return { config, bytes: decodeCompressed(result.data, config, decodeBr), fromCache: true };
    }

    function download(url, onProgress) {
        return new Promise(function (resolve, reject) {
            if (!wxApi || typeof wxApi.downloadFile !== "function") {
                reject(new Error("wx.downloadFile is not available"));
                return;
            }
            const task = wxApi.downloadFile({
                url,
                success: function (result) {
                    if (result.statusCode !== 200 || !result.tempFilePath) {
                        reject(new Error("PCK download failed: HTTP " + result.statusCode));
                    } else {
                        resolve(result.tempFilePath);
                    }
                },
                fail: function (error) {
                    reject(new Error(error && error.errMsg ? error.errMsg : "PCK download failed"));
                },
            });
            if (task && typeof task.onProgressUpdate === "function" && typeof onProgress === "function") {
                task.onProgressUpdate(function (result) { onProgress(result.progress || 0); });
            }
        });
    }

    async function fallback(currentConfig, decodeBr) {
        const old = await readLastGood();
        if (!old || old.br_sha256 === currentConfig.br_sha256 || old.engine_version !== currentConfig.engine_version) {
            throw new Error("No previous successful PCK cache is available");
        }
        return readCached(old, decodeBr);
    }

    async function prepare(config, decodeBr, onProgress) {
        validateConfig(config);
        const old = await readLastGood();
        if (old && old.br_sha256 === config.br_sha256 && old.engine_version === config.engine_version) {
            try {
                return await readCached(config, decodeBr);
            } catch (error) {
                console.warn("Current PCK cache is invalid; downloading again", error);
            }
        }
        try {
            const tempPath = await download(config.url, onProgress);
            const result = await fsCall("readFile", { filePath: tempPath });
            return { config, bytes: decodeCompressed(result.data, config, decodeBr), tempPath, fromCache: false };
        } catch (error) {
            if (!old || old.br_sha256 === config.br_sha256 || old.engine_version !== config.engine_version) {
                throw error;
            }
            console.warn("Remote PCK unavailable; using previous successful version", error);
            return readCached(old, decodeBr);
        }
    }

    async function commit(candidate) {
        if (candidate.fromCache || !candidate.tempPath) return;
        const target = cachePath(candidate.config);
        try {
            await fsCall("copyFile", { srcPath: candidate.tempPath, destPath: target });
        } catch (error) {
            await fsCall("unlink", { filePath: target }).catch(function () {});
            await fsCall("copyFile", { srcPath: candidate.tempPath, destPath: target });
        }
        const previous = await readLastGood();
        await fsCall("writeFile", {
            filePath: lastGoodPath,
            data: JSON.stringify({ schema: 1, config: candidate.config }),
            encoding: "utf8",
        });
        if (previous && previous.br_sha256 !== candidate.config.br_sha256) {
            await fsCall("unlink", { filePath: cachePath(previous) }).catch(function () {});
        }
    }

    gameGlobal.remotePack = { prepare, fallback, commit, decodeCompressed, sha256, validateConfig };
})(typeof globalThis !== "undefined" ? globalThis : this);
