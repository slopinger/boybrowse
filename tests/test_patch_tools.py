import ast
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("chromium_overlay", ROOT / "tools/apply-chromium.py")
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)

class PatchTools(unittest.TestCase):
    def test_whitespace_and_placeholders_brand_the_product_without_changing_attribution(self):
        original = '''<grit><part file="chromium_strings_part.grdp"/>
<message name="IDS_PRODUCT_NAME" desc="Chromium product">
    Chromium
</message>
<message name="IDS_WELCOME">Welcome to <ph name="PRODUCT">Chromium</ph></message>
<message name="IDS_ABOUT_VERSION_COPYRIGHT">The Chromium Authors. All rights reserved.</message>
<message name="IDS_LINK">https://www.chromium.org/</message>
<message name="IDS_OS">ChromiumOS</message></grit>'''
        result = overlay.brand_strings(original)
        messages = {m.attrib["name"]: "".join(m.itertext()).strip() for m in ET.fromstring(result).iter("message")}
        self.assertEqual(messages["IDS_PRODUCT_NAME"], "Boybrowse")
        self.assertEqual(messages["IDS_WELCOME"], "Welcome to Boybrowse")
        self.assertEqual(messages["IDS_ABOUT_VERSION_COPYRIGHT"], "The Chromium Authors. All rights reserved.")
        self.assertEqual(messages["IDS_LINK"], "https://www.chromium.org/")
        self.assertEqual(messages["IDS_OS"], "ChromiumOS")
        self.assertIn('file="chromium_strings_part.grdp"', result)

    def test_sdk_adapter_preserves_upstream_arguments_and_avoids_host_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ("build/util", "build/config/mac", "gpu/config", "skia/ext", "gpu/webgpu"):
                (root / path).mkdir(parents=True, exist_ok=True)
            (root / ".gn").write_text('script_executable = "//third_party/cpython3/host/bin/python3"\n')
            (root / "build/config/gclient_args.gni").write_text("checkout_mac = true\n")
            (root / "chrome").mkdir()
            chrome_build = root / "chrome/BUILD.gn"
            chrome_build.write_text('''bundle_data("chrome_framework_resources") {
  sources = [
      "//ui/gl/resources/angle-metal/gpu_shader_cache.bin",
      "app/theme/product_logo_32.png",
  ]
}
''')
            metal_dir = root / "third_party/angle/src/libANGLE/renderer/metal"
            metal_dir.mkdir(parents=True)
            metal_gni = metal_dir / "metal_backend.gni"
            metal_gni.write_text('''metal_internal_shader_compilation_supported =
    angle_has_build &&
    (angle_metal_toolchain_dir != "" || (!is_ios && target_os == host_os))
''')
            mac_build = root / "build/config/mac/BUILD.gn"
            mac_build.write_text('''config("runtime_library") {
  cflags = common_flags
  ldflags = common_flags
}
''')
            sdk = root / "build/config/mac/mac_sdk.gni"
            sdk.write_text('''import("//build_overrides/build.gni")
declare_args() {
  mac_deployment_target = "13.0"
  mac_min_system_version = "13.0"
  mac_sdk_path = ""
}
# Check that the version of macOS SDK used is the one requested
host_sdk = exec_script("find_sdk.py", [], "scope")
''')
            import json
            info = {"version":overlay.VERSION, "DEPS":{
                "src":{"rev":overlay.REVISION},
                "src/third_party/skia":{"rev":"skia-fixture"},
                "src/third_party/dawn":{"rev":"dawn-fixture"}
            }}
            metadata = root / "info.json"
            metadata.write_text(json.dumps(info))
            subprocess.run([sys.executable, str(ROOT / "tools/prepare-darwin.py"),str(metadata)],
                cwd=root,env={**os.environ,"BOYBROWSE_SDK":"/nix/store/test-sdk","BOYBROWSE_SDK_VERSION":"26.5",
                "BOYBROWSE_SYSTEM_INCLUDES":"/nix/store/test-resolv/include:/nix/store/test-iconv/include"},check=True)
            text = sdk.read_text()
            self.assertIn('import("//build_overrides/build.gni")',text)
            self.assertIn('mac_deployment_target = "13.0"',text)
            self.assertIn('mac_min_system_version = "13.0"',text)
            self.assertIn('mac_sdk_path = "/nix/store/test-sdk"',text)
            self.assertNotIn("exec_script",text)
            self.assertIn(sys.executable,(root / ".gn").read_text())
            self.assertNotIn("third_party/cpython3",(root / ".gn").read_text())
            self.assertIn(overlay.REVISION,(root / "build/util/LASTCHANGE").read_text())
            self.assertNotIn("gpu_shader_cache.bin",chrome_build.read_text())
            self.assertIn("product_logo_32.png",chrome_build.read_text())
            self.assertIn('"-isystem",\n    "/nix/store/test-resolv/include",',mac_build.read_text())
            self.assertIn("ldflags = common_flags",mac_build.read_text())
            self.assertEqual("metal_internal_shader_compilation_supported = false\n",metal_gni.read_text())

    def test_every_python_tool_parses(self):
        for path in (ROOT / "tools").glob("*.py"):
            with self.subTest(path=path.name):
                ast.parse(path.read_text())

if __name__ == "__main__":
    unittest.main()
