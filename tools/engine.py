#!/usr/bin/env python3
"""Prepare the pinned Godot source and build a standard-WebGL2 WeChat host."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=None, capture=False):
    result = subprocess.run([str(a) for a in args], cwd=cwd, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(map(str, args))}\n"
                           + ((result.stderr or result.stdout or '') if capture else ''))
    return result.stdout.strip() if capture else ''


def require(name, hint):
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"Missing {name}. {hint}")
    return found


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def engine_version(label):
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', label)
    if not match:
        raise RuntimeError(f'Cannot determine Godot version from {label!r}')
    return tuple(map(int, match.groups()))


def validate_pck(path, version):
    if not path.is_file() or path.suffix.lower() != '.pck':
        raise RuntimeError(f'Expected an existing .pck file: {path}')
    with path.open('rb') as stream:
        header = stream.read(20)
    if len(header) < 20 or header[:4] != b'GDPC':
        raise RuntimeError('Invalid PCK header (expected GDPC).')
    pack_format = int.from_bytes(header[4:8], 'little')
    actual_version = tuple(int.from_bytes(header[i:i + 4], 'little') for i in (8, 12, 16))
    if pack_format != 4:
        raise RuntimeError(f'Unsupported PCK format {pack_format}; expected 4.')
    if actual_version != version:
        raise RuntimeError(f'PCK was exported by Godot {".".join(map(str, actual_version))}; '
                           f'expected {".".join(map(str, version))}.')


def validate_remote_config(config, config_path=None):
    if not isinstance(config, dict) or config.get('schema') != 1 or config.get('mode') != 'remote':
        raise RuntimeError('Invalid remote PCK config schema or mode.')
    url = config.get('url')
    if not isinstance(url, str):
        raise RuntimeError('Remote PCK URL must be HTTPS.')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not parsed.path.endswith('.pck.br')):
        raise RuntimeError('Remote PCK URL must be a fixed HTTPS .pck.br URL without query or fragment.')
    if config.get('path') != '/engine/demo-pck.bin':
        raise RuntimeError('Remote PCK virtual path must be /engine/demo-pck.bin.')
    for key in ('br_sha256', 'pck_sha256'):
        if not isinstance(config.get(key), str) or not re.fullmatch(r'[0-9a-f]{64}', config[key]):
            raise RuntimeError(f'Invalid {key} in remote PCK config.')
    for key in ('br_size', 'pck_size'):
        if type(config.get(key)) is not int or config[key] <= 0:
            raise RuntimeError(f'Invalid {key} in remote PCK config.')
    if not isinstance(config.get('engine_version'), str) or not re.fullmatch(r'\d+\.\d+\.\d+', config['engine_version']):
        raise RuntimeError('Invalid engine_version in remote PCK config.')
    if config_path is not None:
        artifact = config_path.parent / parsed.path.rsplit('/', 1)[-1]
        if not artifact.is_file() or artifact.stat().st_size != config['br_size'] or sha(artifact) != config['br_sha256']:
            raise RuntimeError(f'Remote PCK artifact missing or changed: {artifact}')
    return config


def validate_scene_pack_manifest(manifest, manifest_path=None):
    if not isinstance(manifest, dict) or manifest.get('schema') != 1:
        raise RuntimeError('Invalid scene pack manifest schema.')
    if not isinstance(manifest.get('entry_scene'), str) or not manifest['entry_scene'].startswith('res://'):
        raise RuntimeError('Invalid scene pack entry_scene.')
    if not isinstance(manifest.get('engine_version'), str) or not re.fullmatch(r'\d+\.\d+\.\d+', manifest['engine_version']):
        raise RuntimeError('Invalid scene pack engine_version.')
    groups, packs = manifest.get('groups'), manifest.get('packs')
    if not isinstance(groups, dict) or not groups or not isinstance(packs, dict) or set(groups) != set(packs):
        raise RuntimeError('Scene pack groups and packs must have matching nonempty IDs.')
    ids = set(groups)
    for name, group in groups.items():
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}', name):
            raise RuntimeError(f'Invalid scene pack ID: {name}')
        if not isinstance(group, dict) or not isinstance(group.get('roots'), list) or not isinstance(group.get('depends'), list):
            raise RuntimeError(f'Invalid scene pack group: {name}')
        if any(dep not in ids or dep == name for dep in group['depends']):
            raise RuntimeError(f'Invalid dependency in scene pack group: {name}')
        pack = packs[name]
        if not isinstance(pack, dict) or pack.get('mode') not in ('local', 'remote'):
            raise RuntimeError(f'Invalid scene pack mode: {name}')
        if pack.get('path') != f'/engine/scene-{name}.pck':
            raise RuntimeError(f'Invalid virtual PCK path: {name}')
        for key in ('br_sha256', 'pck_sha256'):
            if not isinstance(pack.get(key), str) or not re.fullmatch(r'[0-9a-f]{64}', pack[key]):
                raise RuntimeError(f'Invalid {key}: {name}')
        for key in ('br_size', 'pck_size'):
            if type(pack.get(key)) is not int or pack[key] <= 0:
                raise RuntimeError(f'Invalid {key}: {name}')
        filename = pack.get('file')
        if not isinstance(filename, str) or not re.fullmatch(rf'packs/{re.escape(name)}/[a-zA-Z0-9_-]+\.pck\.br', filename):
            raise RuntimeError(f'Invalid scene pack file: {name}')
        if pack['mode'] == 'local':
            if pack.get('subpackage') != f'pack-{name}':
                raise RuntimeError(f'Invalid scene pack subpackage: {name}')
        else:
            url = pack.get('url')
            parsed = urlsplit(url) if isinstance(url, str) else None
            if (parsed is None or parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or not parsed.path.endswith('/' + filename.rsplit('/', 1)[-1])):
                raise RuntimeError(f'Invalid fixed HTTPS scene pack URL: {name}')
        if manifest_path is not None:
            artifact = manifest_path.parent / filename
            if not artifact.is_file() or artifact.stat().st_size != pack['br_size'] or sha(artifact) != pack['br_sha256']:
                raise RuntimeError(f'Scene pack artifact missing or changed: {artifact}')
    visiting, visited = set(), set()
    def visit(name):
        if name in visiting:
            raise RuntimeError(f'Scene pack dependency cycle at {name}')
        if name in visited:
            return
        visiting.add(name)
        for dep in groups[name]['depends']:
            visit(dep)
        visiting.remove(name)
        visited.add(name)
    for name in groups:
        visit(name)
    scenes = manifest.get('scene_to_group')
    if not isinstance(scenes, dict) or scenes.get(manifest['entry_scene']) not in ids:
        raise RuntimeError('Entry scene has no scene pack group.')
    if any(not isinstance(path, str) or not path.startswith('res://') or group not in ids
           for path, group in scenes.items()):
        raise RuntimeError('Invalid scene_to_group mapping.')
    return manifest


class Pipeline:
    def __init__(self, root=ROOT):
        self.root = Path(root).resolve()
        self.manifest = json.loads((self.root / 'engine/manifest.json').read_text(encoding='utf-8'))

    def git(self, source, *args):
        require('git', 'Install Git and add it to PATH.')
        return run(['git', '-C', source, *args], capture=True)

    def check_repo(self, source):
        top = Path(self.git(source, 'rev-parse', '--show-toplevel')).resolve()
        if not top.samefile(source):
            raise RuntimeError(f'Source must be a standalone Git checkout: {source}')
        actual = self.git(source, 'rev-parse', 'HEAD')
        if actual != self.manifest['base_ref']:
            raise RuntimeError(f"Wrong Godot base: expected {self.manifest['base_ref']}, got {actual}. No files changed.")

    def state_path(self, source):
        path = Path(self.git(source, 'rev-parse', '--git-path', 'wechat-adaptation.json'))
        return path if path.is_absolute() else source / path

    def recipe_files(self):
        return [self.root / 'engine/manifest.json',
                *sorted(p for p in (self.root / 'engine/sources').rglob('*') if p.is_file()),
                *(self.root / 'engine/patches' / p for p in self.manifest['patches'])]

    def recipe_hash(self):
        digest = hashlib.sha256()
        for path in self.recipe_files():
            digest.update(path.relative_to(self.root).as_posix().encode())
            digest.update(path.read_bytes())
        return digest.hexdigest()

    def fetch(self, source):
        require('git', 'Install Git and add it to PATH.')
        if (source / '.git').exists():
            head = subprocess.run(['git', '-C', str(source), 'rev-parse', '--verify', 'HEAD'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if head.returncode == 0:
                self.check_repo(source)
                print(f'Pinned source already exists: {source}')
                return
            if any(p.name != '.git' for p in source.iterdir()):
                raise RuntimeError('Incomplete checkout contains files; refusing to overwrite them.')
            if self.git(source, 'remote', 'get-url', 'origin') != self.manifest['upstream_repo']:
                raise RuntimeError('Incomplete checkout has a different origin.')
        else:
            if source.exists() and any(source.iterdir()):
                raise RuntimeError(f'Refusing to fetch into nonempty directory: {source}')
            source.mkdir(parents=True, exist_ok=True)
            run(['git', 'init', source])
            self.git(source, 'config', 'core.longpaths', 'true')
            self.git(source, 'config', 'core.autocrlf', 'false')
            self.git(source, 'remote', 'add', 'origin', self.manifest['upstream_repo'])
        run(['git', '-C', source, 'fetch', '--depth=1', 'origin', self.manifest['base_ref']])
        run(['git', '-C', source, 'checkout', '--detach', self.manifest['base_ref']])
        run(['git', '-C', source, 'submodule', 'update', '--init', '--recursive'])
        self.check_repo(source)

    def verify_applied(self, source):
        self.check_repo(source)
        marker = self.state_path(source)
        if not marker.exists():
            raise RuntimeError('Adaptation is not applied. Run the apply command first.')
        state = json.loads(marker.read_text(encoding='utf-8'))
        if state['recipe'] != self.recipe_hash():
            raise RuntimeError('Adaptation inputs changed; use a fresh checkout. Existing source was preserved.')
        for rel, expected in state['files'].items():
            path = source / rel
            if not path.is_file() or sha(path) != expected:
                raise RuntimeError(f'Adapted source changed: {rel}. Existing edits were preserved.')
        return state

    def apply(self, source):
        self.check_repo(source)
        if self.state_path(source).exists():
            self.verify_applied(source)
            print('Adaptation already applied; no files changed.')
            return
        if self.git(source, 'status', '--porcelain'):
            raise RuntimeError('Source checkout is dirty. Commit/save changes or use a fresh checkout.')
        patches = [self.root / 'engine/patches' / name for name in self.manifest['patches']]
        overlays = {p.relative_to(self.root / 'engine/sources').as_posix(): p
                    for p in (self.root / 'engine/sources').rglob('*') if p.is_file()}
        paths = set(overlays)
        for patch in patches:
            paths.update(re.findall(r'^\+\+\+ b/(.+)$', patch.read_text(encoding='utf-8'), re.M))
        for rel in paths:
            if not (source / rel).resolve().is_relative_to(source.resolve()) or Path(rel).is_absolute():
                raise RuntimeError(f'Invalid patch path: {rel}')
        original = {rel: (source / rel).read_bytes() if (source / rel).exists() else None for rel in paths}
        # Validate the entire series in isolation before touching the user's checkout.
        with tempfile.TemporaryDirectory(prefix='godot-wechat-patches-') as tmp:
            staging = Path(tmp)
            run(['git', 'init', '-q', staging])
            for rel, data in original.items():
                if data is not None:
                    (staging / rel).parent.mkdir(parents=True, exist_ok=True)
                    (staging / rel).write_bytes(data.replace(b'\r\n', b'\n'))
            for rel, path in overlays.items():
                (staging / rel).parent.mkdir(parents=True, exist_ok=True)
                (staging / rel).write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))
            for index, patch in enumerate(patches):
                normalized_patch = staging / f'.patch-{index}'
                normalized_patch.write_bytes(patch.read_bytes().replace(b'\r\n', b'\n'))
                run(['git', 'apply', '--check', normalized_patch], cwd=staging, capture=True)
                run(['git', 'apply', normalized_patch], cwd=staging, capture=True)
            published = []
            try:
                for rel in sorted(paths):
                    dst = source / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    published.append(rel)
                    shutil.copyfile(staging / rel, dst)
                write_json(self.state_path(source), {
                    'recipe': self.recipe_hash(), 'base_ref': self.manifest['base_ref'],
                    'files': {rel: sha(source / rel) for rel in sorted(paths)},
                })
            except BaseException:
                for rel in published:
                    if original[rel] is None:
                        (source / rel).unlink(missing_ok=True)
                    else:
                        (source / rel).write_bytes(original[rel])
                raise
        print(f'Applied and verified {len(patches)} patches and {len(overlays)} source overlays.')

    def build_options(self, enable_3d=False):
        options = dict(self.manifest['build_options'])
        options['disable_3d'] = 'no' if enable_3d else 'yes'
        return options

    def build(self, source, enable_3d, jobs, dry_run=False):
        self.verify_applied(source)
        command = [sys.executable, '-m', 'SCons',
                   *(f'{k}={v}' for k, v in self.build_options(enable_3d).items()), f'-j{jobs}']
        if dry_run:
            print(' '.join(command))
            return
        if importlib.util.find_spec('SCons') is None:
            raise RuntimeError('Missing SCons. Install with: python -m pip install scons')
        emcc = require('emcc', 'Install the pinned Emscripten SDK and activate emsdk_env before building.')
        version = run([emcc, '--version'], capture=True)
        expected = self.manifest['emscripten_version']
        if not re.search(r'(?<!\d)' + re.escape(expected) + r'(?![\d.])', version):
            raise RuntimeError(f'Emscripten {expected} is required; found: {version.splitlines()[0]}')
        metadata = source / '.wechat-build.json'
        metadata.unlink(missing_ok=True)
        run(command, cwd=source)
        outputs = {name: sha(source / 'bin/.web_zip' / name) for name in ('godot.js', 'godot.wasm')}
        write_json(metadata, {'base_ref': self.manifest['base_ref'], 'recipe': self.recipe_hash(),
                              'options': self.build_options(enable_3d), 'outputs': outputs})

    def pack_pck(self, pck, base_url, output):
        version = engine_version(self.manifest['base_label'])
        validate_pck(pck, version)
        parsed = urlsplit(base_url)
        if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
                or parsed.query or parsed.fragment):
            raise RuntimeError('--base-url must be an HTTPS directory URL without query or fragment.')
        brotli = require('brotli', 'Install the Brotli command-line tool and add it to PATH.')
        output.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r'[^A-Za-z0-9_-]+', '-', pck.stem).strip('-') or 'game'
        with tempfile.TemporaryDirectory(prefix='.pck-pack-', dir=output) as tmp:
            compressed = Path(tmp) / 'content.pck.br'
            run([brotli, '-q', '11', '-f', '-o', compressed, pck])
            compressed_hash = sha(compressed)
            artifact_name = f'{stem}-{compressed_hash}.pck.br'
            url = base_url.rstrip('/') + '/' + quote(artifact_name)
            config = {
                'schema': 1, 'mode': 'remote', 'url': url,
                'path': '/engine/demo-pck.bin',
                'br_sha256': compressed_hash, 'br_size': compressed.stat().st_size,
                'pck_sha256': sha(pck), 'pck_size': pck.stat().st_size,
                'engine_version': '.'.join(map(str, version)),
            }
            artifact = output / artifact_name
            config_path = output / f'{stem}-{compressed_hash[:16]}-{hashlib.sha256(url.encode()).hexdigest()[:12]}.json'
            if artifact.exists():
                if sha(artifact) != compressed_hash:
                    raise RuntimeError(f'Existing artifact differs: {artifact}')
            else:
                compressed.replace(artifact)
            if config_path.exists():
                if json.loads(config_path.read_text(encoding='utf-8')) != config:
                    raise RuntimeError(f'Existing remote config differs: {config_path}')
            else:
                write_json(config_path, config)
        print(f'PCK artifact: {artifact}')
        print(f'Remote config: {config_path}')
        return artifact, config_path

    def package(self, source, output, remote_pack_config=None, bundled_pack_config=None, scene_pack_manifest=None, manifest_url=None):
        if manifest_url is not None:
            parsed = urlsplit(manifest_url)
            if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or not parsed.path.endswith('.json')):
                raise RuntimeError('Manifest URL must be a fixed HTTPS .json URL.')
            if remote_pack_config is not None or bundled_pack_config is not None or scene_pack_manifest is not None:
                raise RuntimeError('Remote manifest mode cannot be combined with fixed PCK configurations.')
        if remote_pack_config is not None and bundled_pack_config is not None:
            raise RuntimeError('Choose either a remote or bundled PCK config.')
        self.verify_applied(source)
        node = require('node', 'Install Node.js and add it to PATH.')
        brotli = require('brotli', 'Install the Brotli command-line tool and add it to PATH.')
        if output.exists():
            raise RuntimeError(f'Output already exists: {output}. Use a new --output directory; no files overwritten.')
        if output.is_relative_to(source) or source.is_relative_to(output):
            raise RuntimeError('Output must be separate from the engine checkout.')
        metadata = source / '.wechat-build.json'
        if not metadata.is_file():
            raise RuntimeError('Missing successful build metadata. Run build before package.')
        build = json.loads(metadata.read_text(encoding='utf-8'))
        if build['recipe'] != self.recipe_hash() or build['base_ref'] != self.manifest['base_ref']:
            raise RuntimeError('Engine build does not match the current adaptation.')
        for name, expected in build['outputs'].items():
            path = source / 'bin/.web_zip' / name
            if not path.is_file() or sha(path) != expected:
                raise RuntimeError(f'Engine output changed or missing: {name}. Rebuild the matching engine pair.')
        pack_config_path = remote_pack_config or bundled_pack_config
        packed = None
        if pack_config_path is not None:
            packed = validate_remote_config(json.loads(pack_config_path.read_text(encoding='utf-8')),
                                            pack_config_path)
            if packed['engine_version'] != '.'.join(map(str, engine_version(self.manifest['base_label']))):
                raise RuntimeError('PCK config targets a different Godot engine version.')
        scene_packs = None
        if scene_pack_manifest is not None:
            if bundled_pack_config is None:
                raise RuntimeError('Scene packs require a bundled bootstrap PCK config.')
            scene_packs = validate_scene_pack_manifest(
                json.loads(scene_pack_manifest.read_text(encoding='utf-8')), scene_pack_manifest)
            if scene_packs['engine_version'] != '.'.join(map(str, engine_version(self.manifest['base_label']))):
                raise RuntimeError('Scene packs target a different Godot engine version.')
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.wechat-package-', dir=output.parent) as tmp:
            host = Path(tmp) / 'wxgame'
            shutil.copytree(self.root / 'wechat', host)
            shutil.copyfile(source / 'bin/.web_zip/godot.js', host / 'engine/godot.js')
            run([node, self.root / 'tools/process_godot.js', host / 'engine/godot.js'])
            run([brotli, '-f', '-o', host / 'engine/godot.wasm.br', source / 'bin/.web_zip/godot.wasm'])
            config_path = host / 'project.config.json'
            config = json.loads(config_path.read_text(encoding='utf-8'))
            config['appid'] = ''
            write_json(config_path, config)
            if scene_packs is not None:
                (host / 'engine/scene-pack-config.js').write_text(
                    'export default ' + json.dumps(scene_packs, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
                game_config_path = host / 'game.json'
                game_config = json.loads(game_config_path.read_text(encoding='utf-8'))
                for name, pack in scene_packs['packs'].items():
                    if pack['mode'] == 'local':
                        destination = host / pack['file']
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(scene_pack_manifest.parent / pack['file'], destination)
                        game_config['subpackages'].append({'name': pack['subpackage'], 'root': f'packs/{name}/'})
                write_json(game_config_path, game_config)
            if bundled_pack_config is not None:
                artifact = bundled_pack_config.parent / urlsplit(packed['url']).path.rsplit('/', 1)[-1]
                shutil.copyfile(artifact, host / 'engine/demo-pck.br')
                bundled = {key: value for key, value in packed.items() if key != 'url'}
                bundled['mode'] = 'bundled_br'
                bundled['file'] = 'engine/demo-pck.br'
                (host / 'engine/pack-config.js').write_text(
                    'export default ' + json.dumps(bundled, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
            elif remote_pack_config is not None:
                (host / 'engine/pack-config.js').write_text(
                    'export default ' + json.dumps(packed, ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
            elif manifest_url is not None:
                (host / 'engine/pack-config.js').write_text(
                    'export default ' + json.dumps({'mode': 'manifest', 'manifest_url': manifest_url,
                        'engine_version': '.'.join(map(str, engine_version(self.manifest['base_label'])))},
                        ensure_ascii=False, indent=2) + ';\n', encoding='utf-8')
            write_json(host / 'build-info.json', {
                **build, 'engine_version': self.manifest['base_label'],
                'emscripten_version': self.manifest['emscripten_version'],
                'has_pck': bundled_pack_config is not None,
                'pack_mode': ('manifest' if manifest_url is not None else 'bundled_br' if bundled_pack_config is not None else
                              'remote' if remote_pack_config is not None else 'local'),
                'appid_configured': False,
                'scene_packs': scene_packs is not None,
            })
            if manifest_url is not None:
                note = ('REMOTE MANIFEST: upload the exported .pck.br files first, then manifest.json. '
                        'Configure your own Mini Game AppID before preview.\n')
            elif bundled_pack_config is not None:
                note = ('BUNDLED BROTLI PCK: game resources are included in engine/demo-pck.br. '
                        'Configure your own Mini Game AppID before preview.\n')
            elif remote_pack_config is not None:
                note = ('REMOTE PCK TEMPLATE: upload the matching .pck.br to the configured HTTPS URL '
                        'and configure your own Mini Game AppID before preview.\n')
            else:
                note = ('INCOMPLETE TEMPLATE: export a PCK with the matching Godot version and place it at '
                        'engine/demo-pck.bin. Configure your own Mini Game AppID before preview.\n')
            (host / 'BUILD_STATUS.txt').write_text(note, encoding='utf-8')
            run([node, self.root / 'tools/validate_runtime.js', host])
            host.rename(output)
        mode = ('remote scene manifest configured' if manifest_url is not None else 'bundled Brotli PCK' if bundled_pack_config is not None else
                'remote PCK configured' if remote_pack_config is not None else 'template only: PCK required')
        print(f'Packaged {output} ({mode})')


def main():
    pipeline = Pipeline()
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('fetch', 'apply', 'build', 'package', 'pack-pck'):
        cmd = commands.add_parser(name)
        if name != 'pack-pck':
            cmd.add_argument('--source', type=Path, default=ROOT / pipeline.manifest['source_dir'])
        if name == 'build':
            cmd.add_argument('--enable-3d', action='store_true')
            cmd.add_argument('--jobs', type=int, default=min(8, os.cpu_count() or 1))
            cmd.add_argument('--dry-run', action='store_true')
        if name == 'package':
            cmd.add_argument('--output', type=Path, default=ROOT / 'dist/wxgame')
            pack_group = cmd.add_mutually_exclusive_group()
            pack_group.add_argument('--remote-pack-config', type=Path)
            pack_group.add_argument('--bundled-pack-config', type=Path)
            pack_group.add_argument('--manifest-url', help='HTTPS URL of a schema-2 scene pack manifest')
            cmd.add_argument('--scene-pack-manifest', type=Path)
        if name == 'pack-pck':
            cmd.add_argument('--pck', type=Path, required=True)
            cmd.add_argument('--base-url', required=True)
            cmd.add_argument('--output', type=Path, default=ROOT / 'dist/packs')
    args = parser.parse_args()
    try:
        if args.command == 'pack-pck':
            pipeline.pack_pck(args.pck.resolve(), args.base_url, args.output.resolve())
            return 0
        source = args.source.resolve()
        if args.command == 'fetch':
            pipeline.fetch(source)
        elif args.command == 'apply':
            pipeline.apply(source)
        elif args.command == 'build':
            if args.jobs < 1:
                raise RuntimeError('--jobs must be positive.')
            pipeline.build(source, args.enable_3d, args.jobs, args.dry_run)
        else:
            pipeline.package(source, args.output.resolve(),
                             args.remote_pack_config.resolve() if args.remote_pack_config else None,
                             args.bundled_pack_config.resolve() if args.bundled_pack_config else None,
                             args.scene_pack_manifest.resolve() if args.scene_pack_manifest else None,
                             args.manifest_url)
    except (RuntimeError, OSError, ValueError, KeyError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
