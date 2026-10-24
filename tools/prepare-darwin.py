#!/usr/bin/env python3
"""Adapt Chromium's build metadata to the Nix-provided Apple SDK and toolchains."""
import json
import os
import pathlib
import sys

root = pathlib.Path.cwd()
info = json.loads(pathlib.Path(sys.argv[1]).read_text())
revision = info["DEPS"]["src"]["rev"]
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
(root / "build/config/mac/mac_sdk.gni").write_text(f'''
import("//build/config/mac/mac_sdk_overrides.gni")
declare_args() {{
  mac_sdk_path = "{sdk}"
  mac_sdk_name = "macosx"
}}
mac_sdk_version = "{version}"
mac_sdk_build_version = "nix"
mac_sdk_official_version = mac_sdk_version
mac_sdk_official_build_version = mac_sdk_build_version
mac_bin_path = rebase_path("//third_party/llvm-build/Release+Asserts/bin", root_build_dir)
# Xcode version guards describe SDK compatibility; all compilation uses the
# fixed-output Chromium Clang toolchain and the Nix Apple SDK.
xcode_version = "2660"
xcode_version_int = 2660
xcode_build = "nix-sdk-{version}"
mac_sdk_logs = [ "mac_sdk_path={sdk}", "mac_sdk_version={version}" ]
''')
