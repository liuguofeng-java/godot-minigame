"use strict";
const assert = require("assert"),
    fs = require("fs"),
    os = require("os"),
    path = require("path"),
    vm = require("vm");
const { execFileSync } = require("child_process");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scene-protocol-"));
try {
    for (const enabled of [false, true]) {
        const file = path.join(directory, enabled ? "supported.js" : "legacy.js");
        fs.writeFileSync(
            file,
            `var Engine = (function(){
            function Engine(){}; Engine.load = function(){};
            ${enabled ? "Engine['scenePackProtocol'] = 2;" : ""}
            function SafeEngine(){};
            SafeEngine['load'] = Engine.load;
            return SafeEngine;
        }());`
        );
        execFileSync(process.execPath, [path.join(__dirname, "../tools/process_godot.js"), file], {
            windowsHide: true,
            stdio: "pipe",
        });
        const context = {};
        vm.createContext(context);
        vm.runInContext(fs.readFileSync(file, "utf8"), context);
        assert.equal(context.Engine.scenePackProtocol, enabled ? 2 : undefined);
    }
    console.log(
        "Compiled scene-pack capability is exported without advertising it on legacy engines"
    );
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
