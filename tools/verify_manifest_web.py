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
sys.stdout.reconfigure(encoding='utf-8')


def verify(host, release, brotli, output, scene=None, transitions=None, local_manifest_dev=False):
    host, release, output = Path(host).resolve(), Path(release).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    wasm = subprocess.check_output([brotli, '-d', '-c', str(host / 'engine/godot.wasm.br')], creationflags=flags)
    html = '''<!doctype html><html><head><meta charset="utf-8"></head><body><canvas id="canvas" width="640" height="480"></canvas>
<script src="/wx-host.js"></script><script src="/engine/remote-pack.js"></script>
<script src="/engine/manifest-packs.js"></script><script src="/engine/godot-sdk.js"></script>
<script src="/engine/godot.js"></script><script type="module">
import { BrotliDecode } from '/engine/vendor/brotli-decode.js';
const downloads = [], download = wx.downloadFile;
wx.downloadFile = options => { downloads.push(options.url); return download(options); };
GameGlobal.GODOTSDK.startGame('/engine/godot', START_CONFIG, BrotliDecode)
.then(async()=>{
    const initial = downloads.slice();
    for (const scene of SCENE_TRANSITIONS) await GameGlobal.GODOTSDK.loadScene(scene);
    window.__result={ok:true,files:[...window.__cacheFiles.keys()],initial,downloads};
})
.catch(error=>window.__result={ok:false,error:String(error.stack||error)});
</script></body></html>'''
    build = json.loads((host / 'build-info.json').read_text(encoding='utf-8'))
    version = re.search(r'\d+\.\d+\.\d+', build['engine_version'])
    if not version:
        raise RuntimeError('Host build has no Godot engine version')
    config = {'mode': 'manifest', 'engine_version': version.group(), 'manifest_url': 'https://scene-packs.test/game/manifest.json'}
    if local_manifest_dev:
        config['local_dev'] = True
    if scene:
        config['scene'] = scene
    html = html.replace('START_CONFIG', json.dumps(config)).replace('SCENE_TRANSITIONS', json.dumps(transitions or []))
    logs, errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page()
        def record(message):
            logs.append(message.type + ': ' + message.text)
            (output / 'console.log').write_text('\n'.join(logs + errors), encoding='utf-8')
        page.on('console', record)
        page.on('pageerror', lambda error: errors.append(str(error)))
        def route(request):
            relative = request.request.url.split('scene-packs.test', 1)[1].split('?', 1)[0]
            if relative == '/':
                request.fulfill(status=200, content_type='text/html', body=html)
            elif relative == '/wx-host.js':
                request.fulfill(status=200, content_type='text/javascript', body=(ROOT / 'tests/fixtures/wechat_browser_host.js').read_text())
            elif relative == '/engine/godot.wasm.br':
                request.fulfill(status=200, content_type='application/wasm', body=wasm)
            else:
                base, name = (release, relative.removeprefix('/game/')) if relative.startswith('/game/') else (host, relative.lstrip('/'))
                file = (base / name).resolve()
                if not file.is_relative_to(base) or not file.is_file():
                    request.fulfill(status=404, body='missing')
                else:
                    content_type = 'text/javascript' if file.suffix == '.js' else 'application/json' if file.suffix == '.json' else 'application/octet-stream'
                    request.fulfill(status=200, content_type=content_type, body=file.read_bytes())
        page.route('https://scene-packs.test/**', route)
        result = None
        try:
            page.goto('https://scene-packs.test/')
            page.wait_for_function('window.__result !== undefined', timeout=120000)
            result = page.evaluate('window.__result')
            page.wait_for_timeout(1000)  # Observe the first running frames after scene readiness.
        finally:
            (output / 'console.log').write_text('\n'.join(logs + errors), encoding='utf-8')
            (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            browser.close()
    if not result or not result.get('ok') or errors or any(line.startswith('error:') or 'SCRIPT ERROR:' in line or 'ERROR:' in line for line in logs):
        raise RuntimeError(str(result) + '\n' + '\n'.join((logs + errors)[-15:]))
    assert any(name.endswith('successful.json') for name in result['files']), 'Scene readiness must commit a successful release'
    manifest = json.loads((release / 'manifest.json').read_text(encoding='utf-8'))
    def required(scene_path):
        ids = set()
        def visit(pack):
            if pack in ids:
                return
            ids.add(pack)
            for dependency in manifest['packs'][pack]['depends']:
                visit(dependency)
        visit('bootstrap')
        visit(manifest['scene_to_pack'][scene_path])
        return {config['manifest_url'].rsplit('/', 1)[0] + '/' + manifest['packs'][pack]['url'] for pack in ids}
    expected = required(scene or manifest.get('project_scene') or manifest.get('entry_scene'))
    assert set(result['initial']) == expected, 'Startup downloaded unrelated packages'
    for target in transitions or []:
        expected |= required(target)
    assert set(result['downloads']) == expected and len(result['downloads']) == len(expected), 'Scene loads repeated or omitted packages'
    print('REAL_WASM_MANIFEST_STARTUP_VERIFIED', output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, type=Path)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--brotli', default='brotli')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/manifest-web-verification')
    parser.add_argument('--scene', help='Runtime startup scene override; export scope stays unchanged')
    parser.add_argument('--then-scene', action='append', default=[], help='Load another scene in the same engine after startup (repeatable)')
    parser.add_argument('--local-manifest-dev', action='store_true', help='Exercise LAN development patch-version compatibility')
    args = parser.parse_args()
    verify(args.host, args.release, args.brotli, args.output, args.scene, args.then_scene, args.local_manifest_dev)
