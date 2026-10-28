"use strict";
// Validate schema-2/3/4 releases using the same code as the WeChat runtime.
const fs = require("fs"),
    path = require("path"),
    vm = require("vm"),
    zlib = require("zlib");
const context = { GameGlobal: {}, console, setTimeout, clearTimeout };
vm.createContext(context);
for (const file of ["remote-pack.js", "manifest-packs.js"]) {
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, "../wechat/engine", file), "utf8"),
        context
    );
}
function validate(filename, engineVersion = "4.7.2") {
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    context.GameGlobal.manifestPacks.validate(manifest, engineVersion);
    for (const [id, pack] of Object.entries(manifest.packs)) {
        const bytes = fs.readFileSync(path.join(path.dirname(filename), pack.url));
        context.GameGlobal.remotePack.decodeCompressed(
            bytes,
            Object.assign({ engine_version: engineVersion }, pack),
            (compressed) =>
                zlib.brotliDecompressSync(
                    Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength)
                )
        );
        console.log(`${id}: ${pack.br_size} compressed / ${pack.pck_size} PCK bytes`);
    }
    console.log("SCENE_MANIFEST_VERIFIED", manifest.release_id);
}
if (require.main === module) {
    try {
        if (!process.argv[2])
            throw new Error(
                "Usage: node tools/validate_scene_manifest.js <manifest.json> [engine-version]"
            );
        validate(process.argv[2], process.argv[3]);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = { validate };
