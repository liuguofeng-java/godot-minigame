"""Create a reproducible, directly installable Godot asset ZIP (no engine required)."""
import argparse
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def package(output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((ROOT / 'addons/scene_packer').rglob('*')):
            if path.is_file() and path.suffix in ('.gd', '.cfg', '.uid'):
                entry = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), (2026, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, path.read_bytes())
        license_entry = zipfile.ZipInfo('addons/scene_packer/LICENSE.txt', (2026, 1, 1, 0, 0, 0))
        license_entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(license_entry, (ROOT / 'LICENSE').read_bytes())
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/scene-packer-plugin.zip')
    package(parser.parse_args().output)
