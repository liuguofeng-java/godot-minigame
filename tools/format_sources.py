"""Check or format maintained scripts, excluding vendor code and generated resources."""

from pathlib import Path
import argparse
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
GAME = (ROOT / "project.godot").is_file()
SOURCE_ROOTS = (
    ("characters", "components", "levels", "addons", "tools")
    if GAME
    else ("addons", "examples", "tests", "tools", "wechat")
)
GENERATED = {
    "characters/player/combat/data/source_slash.gd",
    "characters/player/combat/data/sword_paths.gd",
    "tools/assets/enemies/roster_import_data.gd",
}
EXCLUDED = {".godot", ".git", "__pycache__", "node_modules", "vendor", "output", "build", "dist"}


def source_files():
    """Use explicit source roots so downloaded engines and old releases are never edited."""
    paths = list(ROOT.glob("*.py"))
    for folder in SOURCE_ROOTS:
        for directory, children, names in os.walk(ROOT / folder):
            children[:] = sorted(name for name in children if name not in EXCLUDED)
            paths.extend(Path(directory) / name for name in sorted(names))
    return sorted(
        path.relative_to(ROOT).as_posix()
        for path in paths
        if path.suffix in (".gd", ".py", ".js", ".cjs", ".mjs")
        and path.relative_to(ROOT).as_posix() not in GENERATED
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true", help="Apply formatting; default checks only"
    )
    parser.add_argument(
        "--prettier",
        type=Path,
        help="Existing Prettier JS CLI; otherwise use npx with pinned 3.6.2",
    )
    args = parser.parse_args()
    files = source_files()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

    def run(command):
        subprocess.run(command, cwd=ROOT, check=True, creationflags=flags)

    gd = [name for name in files if name.endswith(".gd")]
    py = [name for name in files if name.endswith(".py")]
    js = [name for name in files if name.endswith((".js", ".cjs", ".mjs"))]
    if gd:
        formatter = shutil.which("gdformat")
        if not formatter:
            parser.error("Install requirements-dev.txt before formatting GDScript")
        run([formatter, *([] if args.write else ["--check"]), *gd])
    if py:
        run(
            [
                sys.executable,
                "-m",
                "ruff",
                "format",
                *([] if args.write else ["--check", "--quiet"]),
                *py,
            ]
        )
        run([sys.executable, "-m", "ruff", "check", *py])
    if js:
        command = (
            [shutil.which("node") or "node", str(args.prettier.resolve())]
            if args.prettier
            else [shutil.which("npx") or "npx", "--yes", "--package=prettier@3.6.2", "prettier"]
        )
        run([*command, "--write" if args.write else "--check", *js])
    # gdformat follows the host newline convention; keep source bytes portable on Windows too.
    for name in files:
        path = ROOT / name
        content = path.read_bytes()
        if b"\r\n" in content:
            if not args.write:
                raise SystemExit(f"CRLF source: {name}; run with --write to normalize to LF")
            path.write_bytes(content.replace(b"\r\n", b"\n"))
    print(f"SOURCE_STYLE_VERIFIED gd={len(gd)} py={len(py)} js={len(js)}")


if __name__ == "__main__":
    main()
