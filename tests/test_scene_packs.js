"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const engineDir = path.join(__dirname, "../wechat/engine");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(name, mode) {
    const header = Buffer.alloc(20);
    header.write("GDPC", 0, "ascii");
    [4, 4, 7, 2].forEach((value, index) => header.writeUInt32LE(value, 4 + index * 4));
    const raw = Buffer.concat([header, Buffer.from(name)]);
    const compressed = zlib.brotliCompressSync(raw);
    const file = `packs/${name}/${name}-${hash(compressed).slice(0, 16)}.pck.br`;
    return {
        raw, compressed,
        pack: { mode, file, path: `/engine/scene-${name}.pck`,
            subpackage: `pack-${name}`, url: `https://example.com/${name}-${hash(compressed).slice(0, 16)}.pck.br`,
            pck_size: raw.length, pck_sha256: hash(raw),
            br_size: compressed.length, br_sha256: hash(compressed) },
    };
}

function harness(files = new Map()) {
    const network = new Map();
    const copied = new Map();
    let downloads = 0;
    let subloads = 0;
    const fileSystem = {
        readFile({ filePath, success, fail }) {
            if (!files.has(filePath)) return fail({ errMsg: "missing" });
            success({ data: Buffer.from(files.get(filePath)) });
        },
        copyFile({ srcPath, destPath, success, fail }) {
            if (!files.has(srcPath)) return fail({ errMsg: "missing" });
            files.set(destPath, Buffer.from(files.get(srcPath)));
            success({});
        },
        unlink({ filePath, success }) { files.delete(filePath); success({}); },
    };
    const context = {
        console: { log() {}, warn() {}, error: console.error }, Buffer,
        GameGlobal: { GODOTSDK: { copy_to_fs(path, bytes) { copied.set(path, Buffer.from(bytes)); } } },
        wx: {
            env: { USER_DATA_PATH: "/user" },
            getFileSystemManager: () => fileSystem,
            loadSubpackage({ success }) {
                subloads++;
                setImmediate(success);
                return { onProgressUpdate() {} };
            },
            downloadFile({ url, success, fail }) {
                downloads++;
                setImmediate(() => {
                    const data = network.get(url);
                    if (!data) return fail({ errMsg: "offline" });
                    const tempFilePath = `/temp/${downloads}`;
                    files.set(tempFilePath, Buffer.from(data));
                    success({ statusCode: 200, tempFilePath });
                });
                return { onProgressUpdate() {} };
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(engineDir, "remote-pack.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(engineDir, "scene-packs.js"), "utf8"), context);
    const decode = (data) => zlib.brotliDecompressSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    function configure(packs) {
        context.GameGlobal.scenePacks.configure({ schema: 1, engine_version: "4.7.2", packs }, decode);
    }
    function ensure(id) {
        return new Promise((resolve) => context.GameGlobal.scenePacks.ensure(id, () => {},
            (message) => resolve(JSON.parse(message))));
    }
    return { files, network, copied, configure, ensure,
        get downloads() { return downloads; }, get subloads() { return subloads; } };
}

async function test() {
    const local = fixture("local", "local");
    const h1 = harness();
    h1.files.set(local.pack.file, local.compressed);
    h1.configure({ local: local.pack });
    assert.equal((await h1.ensure("local")).ok, true);
    assert.equal(h1.subloads, 1);
    assert.deepEqual(h1.copied.get(local.pack.path), local.raw);

    const remote = fixture("remote", "remote");
    const sharedFiles = new Map();
    const h2 = harness(sharedFiles);
    h2.network.set(remote.pack.url, remote.compressed);
    h2.configure({ remote: remote.pack });
    const [first, second] = await Promise.all([h2.ensure("remote"), h2.ensure("remote")]);
    assert(first.ok && second.ok, "Concurrent requests should share the same download");
    assert.equal(h2.downloads, 1);
    assert.deepEqual(h2.copied.get(remote.pack.path), remote.raw);

    const h3 = harness(sharedFiles);
    h3.configure({ remote: remote.pack });
    assert.equal((await h3.ensure("remote")).ok, true, "Same-version cache should work offline");
    assert.equal(h3.downloads, 0);

    const cachePath = "/user/scene-pack-" + remote.pack.br_sha256 + ".br";
    sharedFiles.set(cachePath, Buffer.from("damaged"));
    const h4 = harness(sharedFiles);
    h4.network.set(remote.pack.url, remote.compressed);
    h4.configure({ remote: remote.pack });
    assert.equal((await h4.ensure("remote")).ok, true, "Damaged cache should be downloaded again");
    assert.equal(h4.downloads, 1);

    const next = fixture("next", "remote");
    const h5 = harness(sharedFiles);
    h5.configure({ next: next.pack });
    const unavailable = await h5.ensure("next");
    assert.equal(unavailable.ok, false, "New version must not fall back to old cached pack");

    const h6 = harness();
    h6.network.set(remote.pack.url, Buffer.from("damaged"));
    h6.configure({ remote: remote.pack });
    assert.equal((await h6.ensure("remote")).ok, false, "Corrupt download must be rejected");
}

test().then(() => console.log("Scene pack local, remote, cache and failure tests passed"))
    .catch((error) => { console.error(error); process.exitCode = 1; });
