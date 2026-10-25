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

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=None, capture=False):
    result = subprocess.run([str(a) for a in args], cwd=cwd, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
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
    return hashlib.sha256(path.read_bytes()).hexdigest()


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

    def package(self, source, output):
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
            write_json(host / 'build-info.json', {
                **build, 'engine_version': self.manifest['base_label'],
                'emscripten_version': self.manifest['emscripten_version'],
                'has_pck': False, 'appid_configured': False,
            })
            note = 'INCOMPLETE TEMPLATE: export a PCK with the matching Godot version and place it at engine/demo-pck.bin. Configure your own Mini Game AppID before preview.\n'
            (host / 'BUILD_STATUS.txt').write_text(note, encoding='utf-8')
            run([node, self.root / 'tools/validate_runtime.js', host])
            host.rename(output)
        print(f'Packaged {output} (template only: PCK required)')


def main():
    pipeline = Pipeline()
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('fetch', 'apply', 'build', 'package'):
        cmd = commands.add_parser(name)
        cmd.add_argument('--source', type=Path, default=ROOT / pipeline.manifest['source_dir'])
        if name == 'build':
            cmd.add_argument('--enable-3d', action='store_true')
            cmd.add_argument('--jobs', type=int, default=min(8, os.cpu_count() or 1))
            cmd.add_argument('--dry-run', action='store_true')
        if name == 'package':
            cmd.add_argument('--output', type=Path, default=ROOT / 'dist/wxgame')
    args = parser.parse_args()
    source = args.source.resolve()
    try:
        if args.command == 'fetch':
            pipeline.fetch(source)
        elif args.command == 'apply':
            pipeline.apply(source)
        elif args.command == 'build':
            if args.jobs < 1:
                raise RuntimeError('--jobs must be positive.')
            pipeline.build(source, args.enable_3d, args.jobs, args.dry_run)
        else:
            pipeline.package(source, args.output.resolve())
    except (RuntimeError, OSError, ValueError, KeyError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
