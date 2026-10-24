#!/usr/bin/env python3
"""Adapt Chromium's build metadata to the Nix-provided Apple SDK and toolchains."""
import json
import os
import pathlib
import sys

root = pathlib.Path.cwd()
info = json.loads(pathlib.Path(sys.argv[1]).read_text())
revision = info["DEPS"]["src"]["rev"]
dotfile = root / ".gn"
contents = dotfile.read_text()
python_context = 'script_executable = "//third_party/cpython3/host/bin/python3"'
if contents.count(python_context) != 1:
    raise RuntimeError("Chromium Python launcher context changed")
dotfile.write_text(contents.replace(python_context, f'script_executable = "{sys.executable}"'))
(root / "build/util/LASTCHANGE").write_text(f"LASTCHANGE={revision}-refs/tags/{info['version']}@{{#0}}\n")
(root / "build/util/LASTCHANGE.committime").write_text(os.environ.get("SOURCE_DATE_EPOCH", "1") + "\n")
for path, macro, rev in [
    ("gpu/config/gpu_lists_version.h", "GPU_LISTS_VERSION", revision),
    ("skia/ext/skia_commit_hash.h", "SKIA_COMMIT_HASH", info["DEPS"]["src/third_party/skia"]["rev"]),
    ("gpu/webgpu/dawn_commit_hash.h", "DAWN_COMMIT_HASH", info["DEPS"]["src/third_party/dawn"]["rev"]),
]:
    (root / path).write_text(f'#pragma once\n#define {macro} "{rev}"\n')
(root / "gpu/webgpu/DAWN_VERSION").write_text(info["DEPS"]["src/third_party/dawn"]["rev"])
with (root / "build/config/gclient_args.gni").open("a") as file:
    file.write("\ncheckout_mutter = false\ncheckout_glic_e2e_tests = false\ncheckout_clusterfuzz_data = false\n")
# Chromium's stock module discovers Xcode through xcode-select/xcrun. The Nix
# derivation supplies a complete, pinned SDK instead, so no host SDK is consulted.
sdk = os.environ["BOYBROWSE_SDK"]
version = os.environ["BOYBROWSE_SDK_VERSION"]
module = root / "build/config/mac/mac_sdk.gni"
contents = module.read_text()
marker = "# Check that the version of macOS SDK used is the one requested"
if contents.count(marker) != 1:
    raise RuntimeError("Chromium mac SDK module context changed")
# Keep upstream imports and every declared build argument, including deployment
# targets and build_overrides/build.gni's use_system_xcode declaration.
preamble = contents.split(marker,1)[0]
module.write_text(preamble + f'''
mac_sdk_path = "{sdk}"
mac_sdk_version = "{version}"
mac_sdk_build_version = "nix"
mac_sdk_official_version = mac_sdk_version
mac_sdk_official_build_version = mac_sdk_build_version
mac_bin_path = rebase_path("//third_party/llvm-build/Release+Asserts/bin/", root_build_dir)
# Xcode version guards describe SDK compatibility; all compilation uses the
# fixed-output Chromium Clang toolchain and the Nix Apple SDK.
xcode_version = "2660"
xcode_version_int = 2660
xcode_build = "nix-sdk-{version}"
mac_sdk_logs = [ "mac_sdk_path={sdk}", "mac_sdk_version={version}" ]
''')
# gpu_shader_cache.bin is a prebuilt Metal shader cache that Chromium's DEPS fetches from CIPD
# (chromium/gpu/angle-metal-shader-libraries); source archives do not contain it, so do not bundle it.
chrome_build = root / "chrome/BUILD.gn"
bundled = '      "//ui/gl/resources/angle-metal/gpu_shader_cache.bin",\n'
contents = chrome_build.read_text()
if contents.count(bundled) != 1:
    raise RuntimeError("Chromium Metal shader cache bundle context changed")
chrome_build.write_text(contents.replace(bundled, ""))
