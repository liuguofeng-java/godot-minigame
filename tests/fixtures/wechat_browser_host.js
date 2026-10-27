// Test-only wx host for executing the real WebAssembly engine in headless Chromium.
// This does not claim to emulate device-specific WeChat behavior or performance.
window.GameGlobal = window;
window.canvas = document.querySelector("canvas");
const files = new Map();
const directories = new Set(["/user"]);
const bytes = value => typeof value === "string" ? new TextEncoder().encode(value).buffer : value.slice(0);
const read = path => { if (!files.has(path)) throw new Error("ENOENT " + path); return files.get(path).slice(0); };
const filesystem = {
    readFileSync(path, encoding) { const data = read(path); return encoding ? new TextDecoder().decode(data) : data; },
    writeFileSync(path, value) { files.set(path, bytes(value)); },
    mkdirSync(path) { directories.add(path); },
    readdirSync(path) { return [...files.keys()].filter(p => p.startsWith(path + "/")).map(p => p.slice(path.length + 1)); },
    statSync(path, recursive) {
        if (!files.has(path) && !directories.has(path)) throw new Error("ENOENT " + path);
        if (recursive) return [];
        return { isDirectory: () => directories.has(path), isFile: () => files.has(path), size: files.get(path)?.byteLength || 0 };
    },
    unlinkSync(path) { files.delete(path); },
    rmdirSync(path) { directories.delete(path); },
    renameSync(source, destination) { files.set(destination, read(source)); files.delete(source); },
};
for (const method of ["readFile", "writeFile", "mkdir", "readdir", "unlink", "rename", "copyFile"]) {
    filesystem[method] = options => {
        if (method === "readFile" && options.filePath.startsWith("/engine/") && !files.has(options.filePath)) {
            fetch(options.filePath).then(async response => {
                if (!response.ok) throw new Error("HTTP " + response.status);
                options.success({ data: await response.arrayBuffer() });
            }).catch(error => options.fail({ errMsg: error.message }));
            return;
        }
        try {
            let result = {};
            if (method === "readFile") result.data = filesystem.readFileSync(options.filePath, options.encoding);
            if (method === "writeFile") filesystem.writeFileSync(options.filePath, options.data);
            if (method === "mkdir") filesystem.mkdirSync(options.dirPath);
            if (method === "readdir") result.files = filesystem.readdirSync(options.dirPath);
            if (method === "unlink") filesystem.unlinkSync(options.filePath);
            if (method === "rename") filesystem.renameSync(options.oldPath, options.newPath);
            if (method === "copyFile") files.set(options.destPath, read(options.srcPath));
            options.success(result);
        } catch (error) { if (options.fail) options.fail({ errMsg: error.message }); else throw error; }
    };
}
let temp = 0;
window.wx = {
    env: { USER_DATA_PATH: "/user" }, getFileSystemManager: () => filesystem,
    getWindowInfo: () => ({ windowWidth: 640, windowHeight: 480, screenWidth: 640, screenHeight: 480, pixelRatio: 1 }),
    createWebAudioContext: () => new AudioContext(), onHide() {}, onShow() {},
    request(options) {
        fetch(options.url, { method: options.method || "GET" }).then(async response => {
            const data = options.responseType === "arraybuffer" ? await response.arrayBuffer() : await response.text();
            options.success({ statusCode: response.status, data, header: Object.fromEntries(response.headers) });
        }).catch(error => options.fail({ errMsg: error.message }));
        return { onHeadersReceived() {}, onChunkReceived() {}, abort() {} };
    },
    downloadFile(options) {
        fetch(options.url).then(async response => {
            const path = "/download/" + (++temp);
            files.set(path, await response.arrayBuffer());
            options.success({ statusCode: response.status, tempFilePath: path });
        }).catch(error => options.fail({ errMsg: error.message }));
        return { onProgressUpdate() {} };
    },
    exitMiniProgram() {},
};
const nativeWasm = window.WebAssembly;
const wxWasm = Object.create(nativeWasm);
wxWasm.instantiateStreaming = undefined;
wxWasm.instantiate = async (source, imports) => nativeWasm.instantiate(
    typeof source === "string" ? await (await fetch(source)).arrayBuffer() : source, imports);
window.WXWebAssembly = wxWasm;
window.godotLoader = { updateProgress() {}, config: { textConfig: { completeText: "Ready" } }, cleanup() {} };
window.__cacheFiles = files;
