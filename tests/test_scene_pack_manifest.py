import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("engine_pipeline", ROOT / "tools/engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class ScenePackManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="scene-pack-manifest-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = b"compressed fixture"
        self.hash = hashlib.sha256(self.data).hexdigest()
        self.pck_hash = "a" * 64
        self.manifest = {
            "schema": 1,
            "entry_scene": "res://A.tscn",
            "engine_version": "4.7.2",
            "scene_to_group": {"res://A.tscn": "a"},
            "groups": {
                "a": {"roots": ["res://A.tscn"], "depends": ["b"]},
                "b": {"roots": ["res://B.tscn"], "depends": ["c"]},
                "c": {"roots": ["res://C.tscn"], "depends": []},
            },
            "packs": {},
        }
        for name in ("a", "b", "c"):
            file = f"packs/{name}/{name}-{self.hash[:16]}.pck.br"
            path = self.root / file
            path.parent.mkdir(parents=True)
            path.write_bytes(self.data)
            self.manifest["packs"][name] = {
                "mode": "local",
                "path": f"/engine/scene-{name}.pck",
                "file": file,
                "subpackage": f"pack-{name}",
                "br_size": len(self.data),
                "br_sha256": self.hash,
                "pck_size": 123,
                "pck_sha256": self.pck_hash,
            }
        self.path = self.root / "manifest.json"

    def validate(self):
        self.path.write_text(json.dumps(self.manifest))
        return engine.validate_scene_pack_manifest(self.manifest, self.path)

    def test_valid_chain_and_artifacts(self):
        self.assertEqual(self.validate()["entry_scene"], "res://A.tscn")

    def test_cycle_and_missing_pack_are_rejected(self):
        self.manifest["groups"]["c"]["depends"] = ["a"]
        with self.assertRaisesRegex(RuntimeError, "cycle"):
            self.validate()
        self.manifest["groups"]["c"]["depends"] = []
        (self.root / self.manifest["packs"]["c"]["file"]).write_bytes(b"corrupt")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            self.validate()

    def test_remote_url_must_be_fixed_https(self):
        remote = self.manifest["packs"]["b"]
        remote["mode"] = "remote"
        remote["url"] = "http://example.com/b.pck.br"
        with self.assertRaisesRegex(RuntimeError, "HTTPS"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
