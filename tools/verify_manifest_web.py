"""Run the compiled WeChat engine and exported packs in a hidden Chromium wx test host."""

import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding="utf-8")


def home_touch_points(width, top, bottom):
    """Touch locations for the scene-test home composition, in host logical pixels."""
    height = bottom - top
    landscape = width > height * 1.15
    compact = not landscape and height < 680
    header = 64 if landscape or compact else min(96, max(64, height * 0.12))
    primary = 88 if compact else min(112, max(88, width * 0.29))
    help_height, gap = (52, 12) if compact else (56, 18)
    action_height = primary + gap + help_height
    if landscape:
        settings_y = top + 44
        actions_y = top + (height - action_height) / 2 + 24
        center_x = width * 0.54 + min(400, width * 0.44 - 16) / 2
    else:
        header_gap, tail, section_gap = (12, 42, 16) if compact else (16, 48, 22)
        reserved = header + action_height + tail + header_gap + section_gap + 24
        art = min(width - 16, max(100, height - reserved))
        content_height = header + header_gap + art + tail + section_gap + action_height
        start_y = top + max(12, (height - content_height) / 2)
        settings_y = start_y + header / 2
        actions_y = start_y + content_height - action_height
        center_x = width / 2
    return (
        (width - 48, settings_y),
        (center_x, actions_y + primary / 2),
        (center_x, actions_y + primary + gap + help_height / 2),
    )


def verify(
    host,
    release,
    brotli,
    output,
    scene=None,
    transitions=None,
    local_manifest_dev=False,
    confirmed_scene=None,
    fail_gameplay_once=False,
    home_ui=False,
    home_size=(390, 844),
    home_safe_area=False,
    home_preview_only=False,
    home_cycles=3,
):
    host, release, output = Path(host).resolve(), Path(release).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    wasm = subprocess.check_output(
        [brotli, "-d", "-c", str(host / "engine/godot.wasm.br")], creationflags=flags
    )
    html = """<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><canvas id="canvas" width="640" height="480"></canvas>
<script src="/wx-host.js"></script><script src="/engine/remote-pack.js"></script>
<script src="/engine/manifest-packs.js"></script><script src="/engine/godot-sdk.js"></script>
<script src="/engine/godot.js"></script><script type="module">
import { BrotliDecode } from '/engine/vendor/brotli-decode.js';
const downloads = [], timeline = [], download = wx.downloadFile;
const runtime = GameGlobal.manifestPacks, ready = runtime.sceneReady, confirm = runtime.requestConfirm;
const register = runtime.registerSceneLoader;
const record = (event, value) => timeline.push({event, value, at:performance.now()});
window.__homeTest = {downloads, timeline, record};
const log = console.log;
console.log = (...args) => { record('log', args.join(' ')); return log.apply(console, args); };
runtime.registerSceneLoader = (callback, version) => register(payload => {
    const event = JSON.parse(payload); record('bridge', event);
    if (event.event === 'failed') window.__failed = event;
    callback(payload);
}, version);
runtime.sceneReady = scene => {
    record('first_frame', scene);
    window.__initial = downloads.slice(); window.__pageReady = true;
    return ready(scene);
};
runtime.requestConfirm = scene => { record('confirm', scene); return confirm(scene); };
let failedOnce = false;
wx.downloadFile = options => {
    downloads.push(options.url); record('download', options.url);
    if (LOADING_MODE && window.__pageReady) {
        setTimeout(() => {
            if (FAIL_GAMEPLAY && !failedOnce) { failedOnce = true; options.fail({errMsg:'test network interruption'}); }
            else download(options);
        }, 1200);
        return { onProgressUpdate() {} };
    }
    return download(options);
};
GameGlobal.GODOTSDK.startGame('/engine/godot', START_CONFIG, BrotliDecode)
.then(async()=>{
    const initial = window.__initial || downloads.slice();
    window.__started = true;
    if (LOADING_MODE) {
        if ([...window.__cacheFiles.keys()].some(k=>k.endsWith('successful.json'))) throw Error('Loading page committed too early');
        await new Promise((resolve,reject) => {
            const start = performance.now();
            const poll = () => {
                if (timeline.some(e => e.event === 'log' && e.value.includes('GODOT_LOADING_COMPLETE '))) return resolve();
                if (performance.now()-start > 180000) return reject(Error('Gameplay readiness timed out'));
                setTimeout(poll, 20);
            }; poll();
        });
    }
    for (const scene of SCENE_TRANSITIONS) await GameGlobal.GODOTSDK.loadScene(scene);
    const key = [...window.__cacheFiles.keys()].find(k=>k.endsWith('successful.json'));
    const success = key ? JSON.parse(new TextDecoder().decode(window.__cacheFiles.get(key))) : null;
    window.__result={ok:true,files:[...window.__cacheFiles.keys()],initial,downloads,timeline,success};
})
.catch(error=>window.__result={ok:false,error:String(error.stack||error)});
</script></body></html>"""
    build = json.loads((host / "build-info.json").read_text(encoding="utf-8"))
    version = re.search(r"\d+\.\d+\.\d+", build["engine_version"])
    if not version:
        raise RuntimeError("Host build has no Godot engine version")
    config = {
        "mode": "manifest",
        "engine_version": version.group(),
        "manifest_url": "https://scene-packs.test/game/manifest.json",
    }
    if local_manifest_dev:
        config["local_dev"] = True
    if scene:
        config["scene"] = scene
    manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    loading = manifest.get("startup_mode") == "godot_loading"
    html = html.replace("START_CONFIG", json.dumps(config)).replace(
        "SCENE_TRANSITIONS", json.dumps(transitions or [])
    )
    html = html.replace("LOADING_MODE", json.dumps(loading)).replace(
        "FAIL_GAMEPLAY", json.dumps(fail_gameplay_once)
    )
    if home_ui:
        width, height = home_size
        html = html.replace(
            'width="640" height="480"',
            f'width="{width}" height="{height}" style="width:100vw;height:100vh;display:block"',
        )
        html = html.replace(
            "const downloads = [],",
            """wx.getWindowInfo = () => ({windowWidth:innerWidth,windowHeight:innerHeight,
                screenWidth:innerWidth,screenHeight:innerHeight,pixelRatio:1,
                safeArea:window.__safeArea || {left:0,top:0,right:innerWidth,bottom:innerHeight}});
            wx.getMenuButtonBoundingClientRect = () => window.__capsule || {top:0,bottom:0};
            const downloads = [],""",
        )
        if home_safe_area:
            html = html.replace(
                "wx.getWindowInfo =",
                f"window.__safeArea={{left:0,top:44,right:{width},bottom:{height - 34}}};"
                "window.__capsule={top:50,bottom:82}; wx.getWindowInfo =",
            )
    logs, errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="msedge",
            headless=True,
            args=[
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        page = browser.new_page(
            viewport={"width": home_size[0], "height": home_size[1]}
            if home_ui
            else {"width": 640, "height": 480},
            has_touch=home_ui,
        )

        def record(message):
            logs.append(message.type + ": " + message.text)
            (output / "console.log").write_text("\n".join(logs + errors), encoding="utf-8")

        page.on("console", record)
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route(request):
            relative = request.request.url.split("scene-packs.test", 1)[1].split("?", 1)[0]
            if relative == "/":
                request.fulfill(status=200, content_type="text/html", body=html)
            elif relative == "/wx-host.js":
                request.fulfill(
                    status=200,
                    content_type="text/javascript",
                    body=(ROOT / "tests/fixtures/wechat_browser_host.js").read_text(),
                )
            elif relative == "/engine/godot.wasm.br":
                request.fulfill(status=200, content_type="application/wasm", body=wasm)
            elif relative in (
                "/engine/manifest-packs.js",
                "/engine/godot-sdk.js",
                "/engine/remote-pack.js",
            ):
                request.fulfill(
                    status=200,
                    content_type="text/javascript",
                    body=(ROOT / "wechat" / relative.lstrip("/")).read_bytes(),
                )
            else:
                base, name = (
                    (release, relative.removeprefix("/game/"))
                    if relative.startswith("/game/")
                    else (host, relative.lstrip("/"))
                )
                file = (base / name).resolve()
                if not file.is_relative_to(base) or not file.is_file():
                    request.fulfill(status=404, body="missing")
                else:
                    content_type = (
                        "text/javascript"
                        if file.suffix == ".js"
                        else "application/json"
                        if file.suffix == ".json"
                        else "application/octet-stream"
                    )
                    request.fulfill(status=200, content_type=content_type, body=file.read_bytes())

        page.route("https://scene-packs.test/**", route)
        result = None
        try:
            page.goto("https://scene-packs.test/")
            if loading:
                page.wait_for_function("window.__pageReady", timeout=90000)
                page.screenshot(path=str(output / "loading-page.png"))
                if home_ui:
                    page.wait_for_function(
                        "window.__homeTest.timeline.some(e => e.event === 'log' && e.value === 'GODOT_HOME_READY')"
                    )
                    page.wait_for_timeout(1000)
                    assert page.evaluate(
                        "window.__homeTest.downloads.length === window.__initial.length"
                    )
                    assert not page.evaluate(
                        "[...window.__cacheFiles.keys()].some(k=>k.endsWith('successful.json'))"
                    )
                    assert page.evaluate("[canvas.width, canvas.height]") == list(home_size), (
                        "Screenshot must use the requested initial engine size"
                    )
                    page.screenshot(path=str(output / "home-portrait.png"))
                    top, bottom = (90, height - 34) if home_safe_area else (0, height)
                    settings_point, start_point, help_point = home_touch_points(width, top, bottom)
                    dialog_top = top + max(12, (bottom - top - 420) / 2)
                    dialog_right = (width + min(380, width - 32)) / 2
                    page.mouse.click(*settings_point)
                    page.wait_for_timeout(150)
                    page.screenshot(path=str(output / "home-settings.png"))
                    if not home_preview_only:
                        page.mouse.click(width / 2, dialog_top + 146)
                        page.mouse.click(width / 2, dialog_top + 208)
                        page.wait_for_timeout(100)
                        page.screenshot(path=str(output / "home-settings-edited.png"))
                    page.mouse.click(dialog_right - 48, dialog_top + 44)
                    page.mouse.click(*help_point)
                    page.wait_for_timeout(150)
                    page.screenshot(path=str(output / "home-help.png"))
                    page.mouse.click(dialog_right - 48, dialog_top + 44)
                    # The adapted engine fixes its canvas size at startup. Use a fresh
                    # invocation per size; resizing the browser alone is not a rotation test.
                    if home_preview_only:
                        result = page.evaluate(
                            "({ok:true, preview:true, initial:__initial, downloads:__homeTest.downloads,"
                            "timeline:__homeTest.timeline, files:[...__cacheFiles.keys()]})"
                        )
                        assert result["downloads"] == result["initial"]
                        assert not any(k.endswith("successful.json") for k in result["files"])
                        assert not errors and not any("ERROR:" in line for line in logs)
                        print("REAL_WASM_HOME_PREVIEW_VERIFIED", output)
                        return
                    page.evaluate("window.__homeTest.record('start_click', 'level_01')")
                    page.touchscreen.tap(*start_point)
                    page.wait_for_timeout(200)
                    page.screenshot(path=str(output / "home-start-loading.png"))
                if fail_gameplay_once:
                    page.wait_for_function("window.__failed", timeout=90000)
                    page.wait_for_timeout(150)
                    page.screenshot(path=str(output / "retry.png"))
                    assert not page.evaluate(
                        "[...window.__cacheFiles.keys()].some(k=>k.endsWith('successful.json'))"
                    )
                    page.mouse.click(195, 500) if home_ui else page.mouse.click(320, 315)
            page.wait_for_function("window.__result !== undefined", timeout=240000)
            result = page.evaluate("window.__result")
            page.wait_for_timeout(1000)  # Observe the first running frames after scene readiness.
            page.screenshot(path=str(output / "ready.png"))
            if home_ui:
                assert home_size == (390, 844) and not home_safe_area, (
                    "Full interaction coordinates use 390x844; use preview-only for other sizes"
                )
                for cycle in range(home_cycles):
                    page.touchscreen.tap(273, 44)
                    page.wait_for_timeout(150)
                    page.screenshot(path=str(output / f"game-settings-{cycle + 1}.png"))
                    page.touchscreen.tap(195, 452)
                    page.wait_for_timeout(150)
                    page.screenshot(path=str(output / f"return-confirm-{cycle + 1}.png"))
                    if cycle == 0:
                        page.touchscreen.tap(114, 501)
                        page.wait_for_timeout(150)
                        assert (
                            page.evaluate(
                                "__homeTest.timeline.filter(e=>e.event==='log' && e.value==='GODOT_HOME_RETURNED').length"
                            )
                            == 0
                        ), "Cancel must keep the current level"
                        page.touchscreen.tap(195, 452)
                        page.wait_for_timeout(150)
                    page.touchscreen.tap(275, 501)
                    page.wait_for_function(
                        "count => __homeTest.timeline.filter(e=>e.event==='log' && e.value==='GODOT_HOME_RETURNED').length === count",
                        arg=cycle + 1,
                        timeout=30000,
                    )
                    page.wait_for_function(
                        "count => __homeTest.timeline.filter(e=>e.event==='log' && e.value==='GODOT_HOME_READY').length === count",
                        arg=cycle + 2,
                    )
                    page.wait_for_timeout(300)
                    page.screenshot(path=str(output / f"home-returned-{cycle + 1}.png"))
                    if cycle == 0:
                        page.touchscreen.tap(*settings_point)
                        page.wait_for_timeout(150)
                        page.screenshot(path=str(output / "home-settings-persisted.png"))
                        page.touchscreen.tap(326, 256)
                    assert (
                        page.evaluate("__homeTest.timeline.filter(e=>e.event==='confirm').length")
                        == cycle + 1
                    ), "Returning home must not confirm a release"
                    if cycle + 1 < home_cycles:
                        page.touchscreen.tap(*start_point)
                        page.touchscreen.tap(*start_point)
                        page.wait_for_function(
                            "count => __homeTest.timeline.filter(e=>e.event==='log' && e.value.startsWith('GODOT_LOADING_COMPLETE ')).length === count",
                            arg=cycle + 2,
                            timeout=90000,
                        )
                        page.wait_for_timeout(150)
                result = page.evaluate(
                    "({...__result, files:[...__cacheFiles.keys()], downloads:__homeTest.downloads,"
                    "timeline:__homeTest.timeline})"
                )
        finally:
            (output / "console.log").write_text("\n".join(logs + errors), encoding="utf-8")
            (output / "result.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            browser.close()
    expected_warning = lambda line: (
        fail_gameplay_once
        and (
            ("WARNING:" in line and "test network interruption" in line)
            or "at: push_warning (core" in line
        )
    )
    if (
        not result
        or not result.get("ok")
        or errors
        or any(
            (line.startswith("error:") or "SCRIPT ERROR:" in line or "ERROR:" in line)
            and not expected_warning(line)
            for line in logs
        )
    ):
        raise RuntimeError(str(result) + "\n" + "\n".join((logs + errors)[-15:]))
    assert any(name.endswith("successful.json") for name in result["files"]), (
        "Scene readiness must commit a successful release"
    )

    def required(scene_path):
        ids = set()

        def visit(pack):
            if pack in ids:
                return
            ids.add(pack)
            for dependency in manifest["packs"][pack]["depends"]:
                visit(dependency)

        visit("bootstrap")
        visit(manifest["scene_to_pack"][scene_path])
        return {
            config["manifest_url"].rsplit("/", 1)[0] + "/" + manifest["packs"][pack]["url"]
            for pack in ids
        }

    expected = required(scene or manifest.get("project_scene") or manifest.get("entry_scene"))
    assert set(result["initial"]) == expected, "Startup downloaded unrelated packages"
    if loading:
        assert confirmed_scene and result["success"]["confirmed_scene"] == confirmed_scene
        expected |= required(confirmed_scene)
        frame = next(e["at"] for e in result["timeline"] if e["event"] == "first_frame")
        assert all(
            e["at"] >= frame
            for e in result["timeline"]
            if e["event"] == "download" and e["value"] not in result["initial"]
        )
        confirms = [e["at"] for e in result["timeline"] if e["event"] == "confirm"]
        warmups = [
            e["at"]
            for e in result["timeline"]
            if e["event"] == "log" and "[渲染预热] 完成" in e["value"]
        ]
        if confirmed_scene == "res://levels/level_01/level_01.tscn":
            assert (
                warmups
                and len(warmups) == len(confirms)
                and all(confirmed >= warmed for warmed, confirmed in zip(warmups, confirms))
            ), "Version committed before rendering warmup"
        if home_ui:
            clicked = next(e["at"] for e in result["timeline"] if e["event"] == "start_click")
            assert all(
                e["at"] >= clicked
                for e in result["timeline"]
                if e["event"] == "download" and e["value"] not in result["initial"]
            )
            mounted = [
                path
                for e in result["timeline"]
                if e["event"] == "bridge" and e["value"].get("command") == "prepare"
                for path in e["value"].get("packs", [])
            ]
            assert len(mounted) == len(set(mounted)), "Repeated entry remounted packages"
    for target in transitions or []:
        expected |= required(target)
    assert set(result["downloads"]) == expected, "Scene loads omitted packages"
    assert len(result["downloads"]) == len(expected) + (1 if fail_gameplay_once else 0), (
        "Scene loads repeated packages"
    )
    print("REAL_WASM_MANIFEST_STARTUP_VERIFIED", output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, type=Path)
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--brotli", default="brotli")
    parser.add_argument("--output", type=Path, default=ROOT / "build/manifest-web-verification")
    parser.add_argument(
        "--scene", help="Runtime startup scene override; export scope stays unchanged"
    )
    parser.add_argument(
        "--then-scene",
        action="append",
        default=[],
        help="Load another scene in the same engine after startup (repeatable)",
    )
    parser.add_argument(
        "--local-manifest-dev",
        action="store_true",
        help="Exercise LAN development patch-version compatibility",
    )
    parser.add_argument(
        "--confirmed-scene", help="Expected gameplay target selected by the Godot loading page"
    )
    parser.add_argument(
        "--fail-gameplay-once",
        action="store_true",
        help="Interrupt one gameplay download and retry using the actual Godot button",
    )
    parser.add_argument(
        "--home-ui",
        action="store_true",
        help="Inspect the home UI and start via its real touch button",
    )
    parser.add_argument("--home-size", default="390x844", help="Fresh engine canvas WIDTHxHEIGHT")
    parser.add_argument(
        "--home-safe-area", action="store_true", help="Simulate notch and wx capsule"
    )
    parser.add_argument(
        "--home-preview-only", action="store_true", help="Capture home without starting gameplay"
    )
    parser.add_argument("--home-cycles", type=int, default=3, help="Real touch start/return cycles")
    args = parser.parse_args()
    verify(
        args.host,
        args.release,
        args.brotli,
        args.output,
        args.scene,
        args.then_scene,
        args.local_manifest_dev,
        args.confirmed_scene,
        args.fail_gameplay_once,
        args.home_ui,
        tuple(int(n) for n in args.home_size.split("x")),
        args.home_safe_area,
        args.home_preview_only,
        args.home_cycles,
    )
