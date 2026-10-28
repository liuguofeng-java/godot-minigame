"""Create reproducible runtime and editable loading example ZIPs, without overwriting releases."""

import argparse
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def write_zip(path, files):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, content)
    print(path)


def package(output):
    docs = {
        "docs/" + name: (ROOT / "docs" / name).read_bytes()
        for name in ("scene-packs.md", "scene-packs-validation.md", "source-maintenance.md")
    }
    runtime = dict(docs)
    for relative in (
        "manifest-packs.js",
        "godot-sdk.js",
        "remote-pack.js",
        "vendor/brotli-decode.js",
        "vendor/BROTLI-LICENSE.txt",
    ):
        runtime["engine/" + relative] = (ROOT / "wechat/engine" / relative).read_bytes()
    runtime["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    write_zip(output / "scene-packer-runtime-4.0.0.zip", runtime)
    example_root = ROOT / "examples/godot-loading"
    example = dict(docs)
    for source in sorted(example_root.rglob("*")):
        if (
            source.is_file()
            and ".godot" not in source.parts
            and not source.name.endswith(".import")
        ):
            example[source.relative_to(example_root).as_posix()] = source.read_bytes()
    example["README.md"] = example["README.md"].replace(b"../../docs/", b"docs/")
    for source in sorted((ROOT / "addons/scene_packer").rglob("*")):
        if source.is_file() and source.suffix in (".gd", ".cfg", ".uid"):
            example[source.relative_to(ROOT).as_posix()] = source.read_bytes()
    example["addons/scene_packer/LICENSE.txt"] = (ROOT / "LICENSE").read_bytes()
    write_zip(output / "godot-loading-example-4.0.0.zip", example)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    package(parser.parse_args().output_dir.resolve())
