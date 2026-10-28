"""Real Godot export/pack verification; needs matching Web export templates and Brotli."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zlib
import sys
import os

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd):
    flags = (
        (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
        if os.name == "nt"
        else 0
    )
    process = subprocess.run(
        list(map(str, args)),
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
        creationflags=flags,
    )
    output = process.stdout + process.stderr
    if process.returncode or "SCRIPT ERROR:" in output or "ERROR:" in output:
        raise RuntimeError(output)
    return output


def write(root, name, text):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def glb():
    binary = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    description = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteLength": len(binary)}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "min": [0, 0, 0],
                "max": [1, 1, 0],
            }
        ],
    }
    data = json.dumps(description).encode()
    data += b" " * (-len(data) % 4)
    return (
        struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(data) + 8 + len(binary))
        + struct.pack("<II", len(data), 0x4E4F534A)
        + data
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )


def verify(godot, brotli, retain=None):
    temp = None if retain else tempfile.TemporaryDirectory(prefix="godot-scene-export-")
    root = Path(retain or temp.name).resolve()
    root.mkdir(parents=True, exist_ok=True)
    project = root / "project"
    project.mkdir()
    shutil.copytree(ROOT / "addons/scene_packer", project / "addons/scene_packer")
    write(
        project,
        "project.godot",
        """config_version=5
[application]
config/name="Scene pack fixture"
run/main_scene="res://a/A.tscn"
config/features=PackedStringArray("4.7", "GL Compatibility")
[autoload]
Global="*res://a/global.gd"
[rendering]
renderer/rendering_method="gl_compatibility"
""",
    )
    write(
        project,
        "a/A.tscn",
        """[gd_scene load_steps=2 format=3]
[ext_resource type="PackedScene" path="res://b/B.tscn" id="b"]
[node name="A" type="Node3D"]
[node name="B" parent="." instance=ExtResource("b")]
""",
    )
    write(project, "a/global.gd", 'extends Node\nconst IMAGE = preload("res://c/pixel.png")\n')
    write(
        project,
        "b/B.tscn",
        """[gd_scene load_steps=4 format=3]
[ext_resource type="PackedScene" path="res://c/C.tscn" id="c"]
[ext_resource type="Script" path="res://b/logic.gd" id="script"]
[ext_resource type="PackedScene" path="res://c/model.glb" id="model"]
[node name="B" type="Node3D"]
script=ExtResource("script")
[node name="C" parent="." instance=ExtResource("c")]
[node name="Model" parent="." instance=ExtResource("model")]
""",
    )
    write(
        project,
        "b/logic.gd",
        'extends SharedPackBase\nconst IMAGE = preload("../c/pixel.png")\n'
        'func dynamic_scene(name):\n    return load("res://x/" + name + ".tscn")\n'
        'func formatted_scene(name):\n    return load("res://x/%s.tscn" % name) # load("res://missing.tscn")\n',
    )
    write(project, "c/base.gd", "class_name SharedPackBase\nextends Node3D\n")
    write(
        project,
        "c/effect.gdshader",
        "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(1.0); }\n",
    )
    write(
        project,
        "c/C.tscn",
        """[gd_scene load_steps=4 format=3]
[ext_resource type="Texture2D" path="res://c/pixel.png" id="texture"]
[ext_resource type="Shader" path="res://c/effect.gdshader" id="shader"]
[sub_resource type="ShaderMaterial" id="material"]
shader=ExtResource("shader")
[node name="C" type="Sprite3D"]
texture=ExtResource("texture")
material_override=SubResource("material")
""",
    )

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    (project / "c/pixel.png").write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\0\xff\xff\xff\xff"))
        + chunk(b"IEND", b"")
    )
    (project / "c/model.glb").write_bytes(glb())
    write(project, "extra/data.json", '{"value": 1}\n')
    write(project, "extra/excluded.txt", "Must not be packed\n")
    write(project, "single/data.txt", "Explicit single-file selection\n")
    write(project, "x/X.tscn", '[gd_scene format=3]\n[node name="X" type="Node"]\n')
    write(project, "loose/data.txt", "Unreferenced resource pack\n")
    write(
        project,
        "addons/editor_fixture/plugin.cfg",
        '[plugin]\nname="Editor fixture"\nscript="plugin.gd"\n',
    )
    write(project, "addons/editor_fixture/plugin.gd", "@tool\nextends EditorPlugin\n")
    write(
        project,
        "addons/editor_fixture/Panel.tscn",
        '[gd_scene format=3]\n[node name="Panel" type="Control"]\n',
    )
    config = {
        "schema": 1,
        "project_id": "fixture",
        "packs": {
            "a": {"paths": ["res://a"], "depends": []},
            "b": {
                "paths": ["res://b", "res://extra", "res://single/data.txt"],
                "excludes": ["res://extra/excluded.txt"],
                "depends": [],
            },
            "c": {"paths": ["res://c"], "depends": []},
            "x": {"paths": ["res://x"], "depends": []},
            "loose": {"paths": ["res://loose"], "depends": []},
        },
    }
    write(project, "scene_packs.json", json.dumps(config))
    write(
        project,
        "check.gd",
        """extends SceneTree
func _initialize() -> void:
    var analyzer = load("res://addons/scene_packer/analyzer.gd").new()
    var config = JSON.parse_string(FileAccess.get_file_as_string("res://scene_packs.json"))
    var report = analyzer.analyze(config)
    if not report.errors.is_empty():
        push_error(str(report.errors)); quit(1); return
    if report.order != ["c", "b", "a", "loose", "x"]: push_error(str(report.order)); quit(1); return
    if report.project_scene != "res://a/A.tscn": push_error("Engine default scene was not preserved"); quit(1); return
    if report.scene_to_pack.has("res://addons/editor_fixture/Panel.tscn"): push_error("Editor panel became a game scene"); quit(1); return
    config.packs.loose.paths.append("res://addons/editor_fixture/Panel.tscn")
    if analyzer.analyze(config).scene_to_pack.get("res://addons/editor_fixture/Panel.tscn") != "loose":
        push_error("Explicit runtime addon scene was skipped"); quit(1); return
    config.packs.loose.paths = ["res://loose"]
    config.entry_scene = "res://missing-obsolete-entry.tscn"
    if not analyzer.analyze(config).errors.is_empty(): push_error("Obsolete entry still controls export"); quit(1); return
    config.erase("entry_scene")
    config.packs.x.paths = []
    if analyzer.analyze(config).errors.is_empty(): push_error("Unassigned independent scene accepted"); quit(1); return
    config.packs.x.paths = ["res://x"]
    config.packs.x.depends = ["loose"]
    config.packs.loose.depends = ["x"]
    if analyzer.analyze(config).errors.is_empty(): push_error("Unreachable cycle accepted"); quit(1); return
    config.packs.x.depends = []
    config.packs.loose.depends = []
    var broken_x = FileAccess.open("res://x/missing.gd", FileAccess.WRITE)
    broken_x.store_string('extends Node\\nfunc missing():\\n    return load("res://missing.tres")\\n')
    broken_x.close()
    if analyzer.analyze(config).errors.is_empty(): push_error("Independent pack dependency was not checked"); quit(1); return
    DirAccess.remove_absolute("res://x/missing.gd")
    if "res://extra/excluded.txt" in report.owners: push_error("Excluded child still has an owner"); quit(1); return
    config.packs.c.excludes = ["res://c/pixel.png"]
    if analyzer.analyze(config).errors.is_empty(): push_error("Referenced excluded child accepted"); quit(1); return
    config.packs.c.erase("excludes")
    config.packs.c.excludes = ["res://c"]
    config.packs.c.paths.append("res://c/pixel.png")
    var partial = analyzer.analyze(config)
    if partial.owners.get("res://c/pixel.png") != "c" or partial.owners.has("res://c/C.tscn"):
        push_error("Nested re-inclusion disagrees with selection rules"); quit(1); return
    config.packs.c.paths = ["res://c"]
    config.packs.c.erase("excludes")
    var addition = FileAccess.open("res://c/added.txt", FileAccess.WRITE)
    addition.store_string("New directory member")
    addition.close()
    if "res://c/added.txt" not in analyzer.analyze(config).packs.c: push_error("Directory did not include new file"); quit(1); return
    DirAccess.remove_absolute("res://c/added.txt")
    config.packs.c.paths = []
    var missing = analyzer.analyze(config)
    if missing.errors.is_empty(): push_error("Missing ownership accepted"); quit(1); return
    var chain_found = false
    for message in missing.errors:
        if "res://b/B.tscn" in message and "res://c/model.glb" in message:
            chain_found = true
    if not chain_found: push_error("Missing full reference chain: " + str(missing.errors)); quit(1); return
    config.packs.c.paths = ["res://c"]
    config.packs.c.depends = ["a"]
    if analyzer.analyze(config).errors.is_empty(): push_error("Cycle accepted"); quit(1); return
    config.packs.c.depends = []
    config.packs.b.depends = ["x"]
    if "x" not in analyzer.analyze(config).order: push_error("Explicit dependency missing"); quit(1); return
    config.packs.b.depends = []
    var broken = FileAccess.open("res://b/missing.gd", FileAccess.WRITE)
    broken.store_string('extends Node\\nfunc missing():\\n    return load("res://missing.tres")\\n')
    broken.close()
    if analyzer.analyze(config).errors.is_empty(): push_error("Missing resource accepted"); quit(1); return
    DirAccess.remove_absolute("res://b/missing.gd")
    config.packs.b.paths.append("res://c/pixel.png")
    if analyzer.analyze(config).errors.is_empty(): push_error("Duplicate ownership accepted"); quit(1); return
    for path in ["plugin.gd", "exporter.gd", "export_job.gd", "runtime_ready.gd"]:
        if load("res://addons/scene_packer/" + path) == null: quit(1); return
    print("ANALYZER_AND_SCRIPTS_VERIFIED")
    quit()
""",
    )
    settings_path = project / "project.godot"
    settings = settings_path.read_text()
    settings_path.write_text(settings.replace('Global="*res://a/global.gd"', ""), encoding="utf-8")
    print(run([godot, "--headless", "--path", project, "--editor", "--import", "--quit"], project))
    settings_path.write_text(settings, encoding="utf-8")
    print(run([godot, "--headless", "--path", project, "--editor", "--import", "--quit"], project))
    print(run([godot, "--headless", "--path", project, "--script", "res://check.gd"], project))

    def export(name):
        output = root / name
        log = run(
            [
                godot,
                "--headless",
                "--path",
                project,
                "--script",
                "res://addons/scene_packer/export_job.gd",
                "--",
                "--config",
                project / "scene_packs.json",
                "--output",
                output,
                "--brotli",
                brotli,
            ],
            project,
        )
        print(log)
        manifest = json.loads((output / "manifest.json").read_text())
        events = [
            json.loads(line.partition("SCENE_PACKS_PROGRESS ")[2])
            for line in log.splitlines()
            if "SCENE_PACKS_PROGRESS " in line
        ]
        total = 6 + len(manifest["packs"])
        assert (
            events
            and events[0]["done"] == 0
            and events[-1] == {"done": total, "total": total, "stage": "导出完成"}
        ), "Export progress boundaries are wrong"
        assert all(event["total"] == total and isinstance(event["stage"], str) for event in events)
        assert [event["done"] for event in events] == sorted(event["done"] for event in events)
        assert set(range(total + 1)) <= {event["done"] for event in events}, (
            "A completed export step was skipped"
        )
        return manifest, output

    # Independent export copies must also isolate Godot's fixed-name temporary ZIP data.
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_run = pool.submit(export, "first")
        second_run = pool.submit(export, "second")
        first, first_dir = first_run.result()
        second, _ = second_run.result()
    assert first["schema"] == 4 and first["startup_mode"] == "direct" and "entry_scene" not in first
    assert first["project_scene"] == "res://a/A.tscn"
    assert set(first["packs"]) == {"bootstrap", "a", "b", "c", "x", "loose"}
    assert first["scene_to_pack"]["res://x/X.tscn"] == "x"
    assert first["packs"]["a"]["depends"] == ["b", "c"]  # Autoload also references C.
    assert first["packs"]["b"]["depends"] == ["c"]
    assert {"res://b/B.tscn", "res://extra/data.json", "res://single/data.txt"} <= set(
        first["packs"]["b"]["files"]
    )
    for item in first["packs"].values():
        assert "res://extra/excluded.txt" not in item["files"]
        assert not any("excluded.txt" in name for name in item["archive_files"])
    assert first == second, "Repeated exports must be deterministic"
    write(project, "extra/data.json", '{"value": 2}\n')
    scene_b = project / "b/B.tscn"
    scene_b.write_text(
        scene_b.read_text(encoding="utf-8").replace(
            'script=ExtResource("script")',
            'script=ExtResource("script")\nposition=Vector3(1, 0, 0)',
        ),
        encoding="utf-8",
    )
    third, _ = export("third")
    for name in ("a", "c", "x", "loose", "bootstrap"):
        assert first["packs"][name]["br_sha256"] == third["packs"][name]["br_sha256"], name
    assert first["packs"]["b"]["br_sha256"] != third["packs"]["b"]["br_sha256"]
    isolated = root / "isolated"
    isolated.mkdir()
    write(isolated, "project.godot", "config_version=5\n")
    pack_paths = []
    for name in ("c", "b", "a", "bootstrap"):
        item = first["packs"][name]
        compressed = first_dir / item["url"]
        assert hashlib.sha256(compressed.read_bytes()).hexdigest() == item["br_sha256"]
        uncompressed = isolated / (name + ".pck")
        run([brotli, "-d", "-f", "-o", uncompressed, compressed], root)
        assert hashlib.sha256(uncompressed.read_bytes()).hexdigest() == item["pck_sha256"]
        pack_paths.append(uncompressed.as_posix())
    write(
        isolated,
        "verify.gd",
        """extends SceneTree
func _initialize() -> void:
    for pack in %s:
        if not ProjectSettings.load_resource_pack(pack, false): push_error(pack); quit(1); return
    if FileAccess.file_exists("res://extra/excluded.txt"): push_error("Excluded child leaked into PCK"); quit(1); return
    var scene = load("res://a/A.tscn")
    if scene == null: push_error("Missing scene"); quit(1); return
    var instance = scene.instantiate()
    root.add_child(instance)
    var expected_x = 0.0 if OS.get_cmdline_user_args().is_empty() else float(OS.get_cmdline_user_args()[0])
    if instance.get_node("B").position.x != expected_x: push_error("Parent baked a dependency transform"); quit(1); return
    if instance.get_node("B/C").texture.get_width() != 1: push_error("Missing texture"); quit(1); return
    if instance.get_node("B/C").material_override.shader == null: push_error("Missing Shader"); quit(1); return
    if instance.get_node("B/Model").get_child_count() == 0: push_error("Missing GLB"); quit(1); return
    var singleton = load("res://a/global.gd").new()
    if singleton.IMAGE == null: push_error("Missing Autoload dependency"); quit(1); return
    singleton.free()
    print("ISOLATED_SCENE_PACKS_VERIFIED")
    quit()
"""
        % json.dumps(pack_paths),
    )
    print(run([godot, "--headless", "--path", isolated, "--script", "verify.gd"], isolated))
    # Reuse A/C and load only the changed B payload in a fresh process.
    run(
        [brotli, "-d", "-f", "-o", isolated / "b.pck", root / "third" / third["packs"]["b"]["url"]],
        root,
    )
    print(
        run([godot, "--headless", "--path", isolated, "--script", "verify.gd", "--", "1"], isolated)
    )
    assert all(
        p.suffix == ".json" or p.name.endswith(".pck.br")
        for p in first_dir.rglob("*")
        if p.is_file()
    )
    config["packs"]["b"]["depends"] = ["x"]
    write(project, "scene_packs.json", json.dumps(config))
    dynamic, _ = export("dynamic")
    assert set(dynamic["packs"]) == {"bootstrap", "a", "b", "c", "x", "loose"}
    assert dynamic["packs"]["b"]["depends"] == ["c", "x"]
    config["packs"]["b"]["depends"] = []
    write(project, "scene_packs.json", json.dumps(config))
    # Project startup metadata is inherited; it does not narrow export scope.
    standalone_settings = settings.replace('Global="*res://a/global.gd"', "").replace(
        "res://a/A.tscn", "res://x/X.tscn"
    )
    settings_path.write_text(standalone_settings, encoding="utf-8")
    standalone, _ = export("standalone")
    assert set(standalone["packs"]) == set(first["packs"])
    assert standalone["project_scene"] == "res://x/X.tscn"
    assert standalone["packs"]["bootstrap"]["depends"] == []
    assert settings_path.read_text(encoding="utf-8") == standalone_settings
    # A resource project needs no main scene at all; the runtime can choose any indexed scene.
    no_default = standalone_settings.replace('run/main_scene="res://x/X.tscn"', "")
    settings_path.write_text(no_default, encoding="utf-8")
    catalog, _ = export("catalog")
    assert catalog["project_scene"] == "" and set(catalog["packs"]) == set(first["packs"])
    assert settings_path.read_text(encoding="utf-8") == no_default
    # Use the actual editable loading controller with no dependency on gameplay classes.
    example = ROOT / "examples/godot-loading"
    (project / "boot").mkdir()
    shutil.copyfile(example / "assets/fonts/noto-sans-sc-controls.ttf", project / "boot/font.ttf")
    # Include the independent view as well as the persistent controller.
    for source in sorted((example / "levels/loading").iterdir()):
        if source.suffix in (".gd", ".tscn", ".uid"):
            write(
                project,
                "boot/" + source.name,
                source.read_text(encoding="utf-8")
                .replace("res://levels/loading/", "res://boot/")
                .replace("res://assets/fonts/noto-sans-sc-controls.ttf", "res://boot/font.ttf"),
            )
    config["packs"]["boot"] = {"paths": ["res://boot"], "depends": []}
    write(project, "scene_packs.json", json.dumps(config))
    for target in ("a/A", "x/X"):
        loading_settings = (
            no_default
            + '\n[scene_packer]\nstartup_mode="godot_loading"\ninitial_scene="res://'
            + target
            + '.tscn"\n'
        )
        loading_settings = loading_settings.replace(
            "[application]", '[application]\nrun/main_scene="res://boot/loading.tscn"'
        )
        settings_path.write_text(loading_settings, encoding="utf-8")
        print(
            run([godot, "--headless", "--path", project, "--editor", "--import", "--quit"], project)
        )
        loading, _ = export("loading-" + target[0])
        assert loading["startup_mode"] == "godot_loading"
        assert loading["project_scene"] == "res://boot/loading.tscn"
        assert loading["packs"]["boot"]["depends"] == []
        assert loading["packs"]["bootstrap"]["depends"] == []
        assert loading["scene_to_pack"]["res://" + target + ".tscn"] == target[0]
        assert settings_path.read_text(encoding="utf-8") == loading_settings
    print("REAL_SCENE_EXPORT_VERIFIED", root)
    if temp:
        temp.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--godot", required=True)
    parser.add_argument("--brotli", default=shutil.which("brotli") or "brotli")
    parser.add_argument(
        "--retain", type=Path, help="New directory to retain the fixture and exported releases"
    )
    args = parser.parse_args()
    verify(args.godot, args.brotli, args.retain)
