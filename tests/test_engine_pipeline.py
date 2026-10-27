import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pipeline', ROOT / 'tools/engine.py')
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wechat-pipeline-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'project'
        self.source = Path(self.tmp.name) / 'godot'
        self.source.mkdir()
        self.root.mkdir()
        for directory in ['wechat', 'tools']:
            shutil.copytree(ROOT / directory, self.root / directory, ignore=shutil.ignore_patterns('__pycache__'))
        (self.root / 'engine/patches').mkdir(parents=True)
        (self.root / 'engine/sources/platform/web').mkdir(parents=True)
        (self.root / 'engine/sources/platform/web/adapter.js').write_text('readable adapter\n')
        (self.source / 'audio.cpp').write_text('before\n')
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        manifest = json.loads((ROOT / 'engine/manifest.json').read_text())
        manifest['base_ref'] = self.git('rev-parse', 'HEAD')
        manifest['upstream_repo'] = str(self.source)
        manifest['patches'] = ['audio.patch']
        (self.root / 'engine/manifest.json').write_text(json.dumps(manifest))
        self.patch = self.root / 'engine/patches/audio.patch'
        self.patch.write_text('diff --git a/audio.cpp b/audio.cpp\n--- a/audio.cpp\n+++ b/audio.cpp\n@@ -1 +1 @@\n-before\n+after\n')
        self.pipe = pipeline.Pipeline(self.root)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], text=True).strip()

    def test_apply_repeat_and_protect_changes(self):
        self.pipe.apply(self.source)
        self.pipe.apply(self.source)
        self.assertEqual((self.source / 'audio.cpp').read_text(), 'after\n')
        (self.source / 'audio.cpp').write_text('my change\n')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.pipe.apply(self.source)
        self.assertEqual((self.source / 'audio.cpp').read_text(), 'my change\n')

    def test_failed_series_does_not_publish_overlays(self):
        self.patch.write_text(self.patch.read_text().replace('-before', '-not-the-base'))
        with self.assertRaises(RuntimeError):
            self.pipe.apply(self.source)
        self.assertEqual((self.source / 'audio.cpp').read_text(), 'before\n')
        self.assertFalse((self.source / 'platform').exists())

    def test_dirty_and_wrong_base_are_rejected(self):
        (self.source / 'audio.cpp').write_text('keep me\n')
        with self.assertRaisesRegex(RuntimeError, 'dirty'):
            self.pipe.apply(self.source)
        self.git('add', '.')
        self.git('commit', '-qm', 'new version')
        with self.assertRaisesRegex(RuntimeError, 'Wrong Godot base'):
            self.pipe.apply(self.source)
        self.assertEqual((self.source / 'audio.cpp').read_text(), 'keep me\n')

    def test_fetch_pins_and_preserves_existing(self):
        destination = Path(self.tmp.name) / 'fetched'
        self.pipe.fetch(destination)
        (destination / 'audio.cpp').write_text('local edit\n')
        self.pipe.fetch(destination)
        self.assertEqual((destination / 'audio.cpp').read_text(), 'local edit\n')

    def test_3d_switch_changes_only_one_option(self):
        before, after = self.pipe.build_options(), self.pipe.build_options(True)
        self.assertEqual({k for k in before if before[k] != after[k]}, {'disable_3d'})
        self.assertEqual((before['disable_3d'], after['disable_3d']), ('yes', 'no'))

    def test_cli_default_source_comes_from_manifest(self):
        self.pipe.manifest['source_dir'] = 'build/isolated-version'
        with mock.patch.object(pipeline, 'ROOT', self.root), \
                mock.patch.object(pipeline, 'Pipeline', return_value=self.pipe), \
                mock.patch.object(pipeline.sys, 'argv', ['engine.py', 'fetch']), \
                mock.patch.object(self.pipe, 'fetch') as fetch:
            self.assertEqual(pipeline.main(), 0)
            fetch.assert_called_once_with((self.root / 'build/isolated-version').resolve())

    def test_old_emscripten_is_rejected_before_build(self):
        self.pipe.apply(self.source)
        with mock.patch.object(pipeline.importlib.util, 'find_spec', return_value=object()), \
                mock.patch.object(pipeline, 'require', return_value='emcc'), \
                mock.patch.object(self.pipe, 'verify_applied'), \
                mock.patch.object(pipeline, 'run', return_value='emcc 4.0.10') as command:
            with self.assertRaisesRegex(RuntimeError, 'Emscripten 4.0.11 is required'):
                self.pipe.build(self.source, False, 2)
            command.assert_called_once_with(['emcc', '--version'], capture=True)
        self.assertFalse((self.source / '.wechat-build.json').exists())

    def test_missing_dependency_is_explicit(self):
        with mock.patch.object(pipeline.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Missing brotli'):
                pipeline.require('brotli', 'Install Brotli.')

    @unittest.skipUnless(shutil.which('brotli'), 'Brotli CLI required for manifest packaging test')
    def test_remote_manifest_template_and_conflicts(self):
        self.fake_build()
        output = Path(self.tmp.name) / 'manifest-host'
        self.pipe.package(self.source, output, manifest_url='https://cdn.example/game/manifest.json')
        config = (output / 'engine/pack-config.js').read_text()
        self.assertIn('"mode": "manifest"', config)
        self.assertIn('https://cdn.example/game/manifest.json', config)
        info = json.loads((output / 'build-info.json').read_text())
        self.assertEqual(info['pack_mode'], 'manifest')
        self.assertFalse(info['has_pck'])
        self.assertFalse((output / 'engine/demo-pck.bin').exists())
        with self.assertRaisesRegex(RuntimeError, 'cannot be combined'):
            self.pipe.package(self.source, output, bundled_pack_config=Path('unused'),
                              manifest_url='https://cdn.example/manifest.json')
        with self.assertRaisesRegex(RuntimeError, 'HTTPS'):
            self.pipe.package(self.source, output, manifest_url='http://cdn.example/manifest.json')

    def fake_build(self):
        self.pipe.apply(self.source)
        binary = self.source / 'bin/.web_zip'
        binary.mkdir(parents=True)
        (binary / 'godot.js').write_text('var WXMEMFS={};var nowPolyfill=function(){};'
                                        'var wasmImports={};/* wx.exitMiniProgram wasm.br godot_audio_sample_register_native_stream */')
        (binary / 'godot.wasm').write_bytes(b'\x00asm\x01\x00\x00\x00')
        pipeline.write_json(self.source / '.wechat-build.json', {
            'base_ref': self.pipe.manifest['base_ref'], 'recipe': self.pipe.recipe_hash(),
            'options': self.pipe.build_options(),
            'outputs': {name: pipeline.sha(binary / name) for name in ['godot.js', 'godot.wasm']},
        })
        return binary

    def pck_fixture(self, version=(4, 7, 2)):
        path = Path(self.tmp.name) / 'sample.pck'
        header = (b'GDPC' + (4).to_bytes(4, 'little') +
                  b''.join(part.to_bytes(4, 'little') for part in version))
        path.write_bytes(header + b'Godot PCK fixture\x00' * 16)
        return path

    def test_pack_pck_rejects_invalid_header_and_version(self):
        pck = self.pck_fixture()
        pck.write_bytes(b'not a PCK')
        with self.assertRaisesRegex(RuntimeError, 'Invalid PCK header'):
            self.pipe.pack_pck(pck, 'https://cdn.example.com/game/', Path(self.tmp.name) / 'packs')
        pck = self.pck_fixture(version=(4, 8, 0))
        with self.assertRaisesRegex(RuntimeError, 'expected 4.7.2'):
            self.pipe.pack_pck(pck, 'https://cdn.example.com/game/', Path(self.tmp.name) / 'packs')
        pck = self.pck_fixture()
        with self.assertRaisesRegex(RuntimeError, 'HTTPS directory URL'):
            self.pipe.pack_pck(pck, 'http://cdn.example.com/game/', Path(self.tmp.name) / 'packs')

    @unittest.skipUnless(shutil.which('brotli'), 'Brotli CLI required for PCK packaging test')
    def test_pack_pck_roundtrip_and_remote_template(self):
        pck = self.pck_fixture()
        packs = Path(self.tmp.name) / 'packs'
        artifact, config_path = self.pipe.pack_pck(pck, 'https://cdn.example.com/game/', packs)
        self.assertEqual(subprocess.check_output(['brotli', '-d', '-c', str(artifact)]), pck.read_bytes())
        config = json.loads(config_path.read_text(encoding='utf-8'))
        self.assertEqual(config['url'], 'https://cdn.example.com/game/' + artifact.name)
        self.assertEqual(config['pck_sha256'], pipeline.sha(pck))
        self.assertEqual(config['br_sha256'], pipeline.sha(artifact))
        self.assertEqual(self.pipe.pack_pck(pck, 'https://cdn.example.com/game/', packs),
                         (artifact, config_path))
        self.fake_build()
        output = Path(self.tmp.name) / 'remote-template'
        self.pipe.package(self.source, output, config_path)
        self.assertFalse((output / 'engine/demo-pck.bin').exists())
        self.assertIn(config['url'], (output / 'engine/pack-config.js').read_text(encoding='utf-8'))
        self.assertEqual(json.loads((output / 'build-info.json').read_text())['pack_mode'], 'remote')
        bundled_output = Path(self.tmp.name) / 'bundled-project'
        self.pipe.package(self.source, bundled_output, bundled_pack_config=config_path)
        self.assertEqual((bundled_output / 'engine/demo-pck.br').read_bytes(), artifact.read_bytes())
        self.assertIn('"mode": "bundled_br"',
                      (bundled_output / 'engine/pack-config.js').read_text(encoding='utf-8'))
        self.assertEqual(json.loads((bundled_output / 'build-info.json').read_text())['pack_mode'], 'bundled_br')
        config['br_sha256'] = '0' * 64
        pipeline.write_json(config_path, config)
        with self.assertRaisesRegex(RuntimeError, 'missing or changed'):
            self.pipe.package(self.source, Path(self.tmp.name) / 'bad-remote', config_path)

    @unittest.skipUnless(shutil.which('brotli'), 'Brotli CLI required for real packaging test')
    def test_package_template_and_output_protection(self):
        binary = self.fake_build()
        output = Path(self.tmp.name) / 'template-only'
        self.pipe.package(self.source, output)
        self.assertFalse((output / 'engine/demo-pck.bin').exists())
        for rel in ['game.js', 'godot-loader.js', 'weapp-adapter.js', 'engine/godot-sdk.js', 'NOTICE.md']:
            self.assertEqual((output / rel).read_bytes(), (self.root / 'wechat' / rel).read_bytes())
        config = json.loads((output / 'project.config.json').read_text(encoding='utf-8'))
        self.assertEqual(config['appid'], '')
        info = json.loads((output / 'build-info.json').read_text(encoding='utf-8'))
        self.assertFalse(info['has_pck'])
        self.assertFalse(info['appid_configured'])
        self.assertEqual(info['engine_version'], self.pipe.manifest['base_label'])
        self.assertEqual(info['emscripten_version'], self.pipe.manifest['emscripten_version'])
        self.assertIn('INCOMPLETE', (output / 'BUILD_STATUS.txt').read_text())
        decoded = subprocess.check_output(['brotli', '-d', '-c', str(output / 'engine/godot.wasm.br')])
        self.assertEqual(decoded, (binary / 'godot.wasm').read_bytes())
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            self.pipe.package(self.source, output)
        (binary / 'godot.js').write_text('mismatched engine')
        with self.assertRaisesRegex(RuntimeError, 'changed or missing'):
            self.pipe.package(self.source, Path(self.tmp.name) / 'bad')


if __name__ == '__main__':
    unittest.main()
