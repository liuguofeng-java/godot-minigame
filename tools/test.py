"""Run dependency-free source tests; engine compilation is a separate check."""

from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
for path in sorted((root / "tests").glob("test_*.js")):
    subprocess.run(["node", str(path)], cwd=root, check=True)
subprocess.run(
    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"],
    cwd=root,
    check=True,
)
