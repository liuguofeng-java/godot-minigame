"""Check the native plugin layout at several panel sizes without opening windows."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(godot, project, arguments, marker):
    command = [godot, '--headless', '--path', str(project), *arguments, '--quit-after', '600']
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace',
        timeout=45, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    output = result.stdout + result.stderr
    if result.returncode or 'ERROR:' in output or marker not in output:
        raise RuntimeError(output)
    print(output)


def verify(godot, preview_dir=None):
    with tempfile.TemporaryDirectory(prefix='scene-packer-panel-') as temporary:
        project = Path(temporary)
        shutil.copytree(ROOT / 'addons/scene_packer', project / 'addons/scene_packer')
        shutil.copyfile(ROOT / 'tests/fixtures/check_packer_panel.gd', project / 'check.gd')
        shutil.copyfile(ROOT / 'tests/fixtures/check_selection_rules.gd', project / 'selection_check.gd')
        (project / 'project.godot').write_text('config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n')
        run(godot, project, ['--script', 'res://check.gd'], 'SCENE_PACKER_PANEL_VERIFIED')
        run(godot, project, ['--script', 'res://selection_check.gd'], 'SCENE_PACKER_SELECTION_RULES_VERIFIED')
        probe = project / 'addons/panel_probe'
        probe.mkdir()
        shutil.copyfile(ROOT / 'tests/fixtures/check_packer_editor.gd', probe / 'plugin.gd')
        (probe / 'plugin.cfg').write_text('[plugin]\nname="Panel probe"\ndescription="Test only"\nauthor="Tests"\nversion="1"\nscript="plugin.gd"\n')
        (project / 'project.godot').write_text('config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n'
            '[editor_plugins]\nenabled=PackedStringArray("res://addons/scene_packer/plugin.cfg", "res://addons/panel_probe/plugin.cfg")\n')
        for name in ['a', 'b']:
            (project / name).mkdir()
            (project / name / (name.upper() + '.tscn')).write_text('[gd_scene format=3]\n[node name="Root" type="Node"]\n')
        nested = project / 'a/nested'
        nested.mkdir()
        (nested / 'one.txt').write_text('One')
        (nested / 'two.txt').write_text('Two')
        (project / 'scene_packs.json').write_text(json.dumps({'schema': 1, 'project_id': 'layout-test', 'entry_scene': 'res://a/A.tscn',
            'packs': {'a': {'paths': ['res://a'], 'depends': ['b']}, 'b': {'paths': ['res://b'], 'depends': []}}}))
        run(godot, project, ['--editor'], 'SCENE_PACKER_EDITOR_ACTIONS_VERIFIED')
        run(godot, project, ['--script', 'res://check.gd'], 'SCENE_PACKER_PANEL_VERIFIED')
        shutil.copyfile(ROOT / 'tests/fixtures/check_dependency_cache.gd', project / 'cache_check.gd')
        run(godot, project, ['--script', 'res://cache_check.gd'], 'SCENE_PACKER_DEPENDENCY_CACHE_VERIFIED')
        if preview_dir:
            preview_dir.mkdir(parents=True, exist_ok=False)
            shutil.copyfile(project / 'preview_theme.res', preview_dir / 'preview_theme.res')
            shutil.copyfile(ROOT / 'addons/scene_packer/packer_panel.gd', preview_dir / 'packer_panel.gd')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--godot', required=True)
    parser.add_argument('--preview-dir', type=Path, help='Optional new directory for native theme and panel rendering inputs')
    args = parser.parse_args()
    verify(args.godot, args.preview_dir)
