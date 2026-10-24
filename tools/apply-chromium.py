#!/usr/bin/env python3
"""Apply an exact, reviewable source overlay. Fail when upstream context changes."""
import json
import pathlib
import re
import shutil
import sys

REVISION = "1d17a2e2ee147bb7d6ae2ab6abdb3a2510c17775"
VERSION = "156.0.8078.47"

def replace(root, path, before, after):
    file = root / path
    source = file.read_text()
    if source.count(before) != 1:
        raise RuntimeError(f"{path}: expected exactly one patch context: {before[:80]!r}")
    file.write_text(source.replace(before, after))

def brand_strings(source):
    def message(match):
        opening, body, closing = match.groups()
        if "Chromium Authors" in body or "COPYRIGHT" in opening:
            return match.group(0)
        return opening + re.sub(r"\bChromium\b", "Boybrowse", body) + closing
    return re.sub(r"(<message\b[^>]*>)(.*?)(</message>)", message, source, flags=re.DOTALL)

def apply(root, overlay):
    version = dict(line.split("=", 1) for line in (root / "chrome/VERSION").read_text().splitlines())
    actual = ".".join(version[k] for k in ("MAJOR", "MINOR", "BUILD", "PATCH"))
    if actual != VERSION:
        raise RuntimeError(f"Unsupported Chromium {actual}; expected {VERSION}")
    target = root / "chrome/browser/ui/webui/boybrowse"
    if target.exists():
        raise RuntimeError("Boybrowse overlay already exists; use a fresh source tree")
    target.mkdir()
    for name in ("boybrowse_ui.h", "boybrowse_ui.cc", "BUILD.gn"):
        shutil.copyfile(overlay / name, target / name)
    resources = sorted((overlay / "ui").iterdir())
    header = ['#include <array>\n#include <string_view>\n#include <utility>\n',
              'constexpr auto kBoybrowseResources = std::to_array<std::pair<std::string_view, std::string_view>>({\n']
    for file in resources:
        if not file.is_file():
            continue
        content = file.read_text().replace(".mjs", ".js")
        delimiter = "boybrowse_asset"
        if f'){delimiter}"' in content:
            raise RuntimeError("Raw string delimiter collision")
        name = file.name.replace(".mjs", ".js")
        header.append(f'{{"{name}", R"{delimiter}({content}){delimiter}"}},\n')
    header.append("});\n")
    (target / "resources.h").write_text("".join(header))
    manifest = (overlay.parent / "blocker/manifest.json").read_text()
    (root / "chrome/browser/extensions/boybrowse_shields_manifest.h").write_text(
        'constexpr char kBoybrowseShieldsManifest[] = R"shields(' + manifest + ')shields";\n')
    replace(root, "chrome/browser/extensions/component_loader.cc",
            '#include "chrome/browser/extensions/component_loader.h"',
            '#include "chrome/browser/extensions/component_loader.h"\n'
            '#include "chrome/browser/extensions/boybrowse_shields_manifest.h"')
    replace(root, "chrome/browser/extensions/component_loader.cc",
            "void ComponentLoader::AddDefaultComponentExtensionsWithBackgroundPages(\n    bool skip_session_components) {",
            "void ComponentLoader::AddDefaultComponentExtensionsWithBackgroundPages(\n    bool skip_session_components) {\n"
            '  Add(kBoybrowseShieldsManifest, base::FilePath(FILE_PATH_LITERAL("boybrowse_blocker")), true);')
    replace(root, "chrome/common/chrome_paths_mac.mm",
            'product_dir_name = "Chromium";',
            'product_dir_name = "Boybrowse";')
    replace(root, "chrome/browser/ui/webui/chrome_web_ui_configs.cc",
            '#include "chrome/browser/ui/webui/chrome_web_ui_configs.h"',
            '#include "chrome/browser/ui/webui/chrome_web_ui_configs.h"\n#include "chrome/browser/ui/webui/boybrowse/boybrowse_ui.h"')
    replace(root, "chrome/browser/ui/webui/chrome_web_ui_configs.cc",
            "  auto& map = content::WebUIConfigMap::GetInstance();",
            "  auto& map = content::WebUIConfigMap::GetInstance();\n  map.AddWebUIConfig(std::make_unique<BoybrowseUIConfig>());")
    replace(root, "chrome/browser/ui/webui/BUILD.gn",
            'source_set("configs") {',
            'source_set("configs") {\n  public_deps = [ "//chrome/browser/ui/webui/boybrowse" ]')
    # The desktop public_deps assignment must append rather than replace our dependency.
    replace(root, "chrome/browser/ui/webui/BUILD.gn",
            '  if (!is_android) {\n    public_deps = [',
            '  if (!is_android) {\n    public_deps += [')
    replace(root, "chrome/browser/prefs/browser_prefs.cc",
            '  TRACE_EVENT0("browser", "chrome::RegisterProfilePrefs");',
            '  TRACE_EVENT0("browser", "chrome::RegisterProfilePrefs");\n'
            '  registry->RegisterDictionaryPref("boybrowse.state");\n'
            '  registry->RegisterStringPref("boybrowse.secrets", "");')
    replace(root, "chrome/browser/search/search.cc",
            "    const bool default_is_google = DefaultSearchProviderIsGoogle(profile);",
            '    if (!profile->IsOffTheRecord())\n'
            '      return NewTabURLDetails(GURL("chrome://boybrowse/"), NEW_TAB_URL_VALID);\n\n'
            "    const bool default_is_google = DefaultSearchProviderIsGoogle(profile);")
    replace(root, "chrome/browser/ui/tabs/tab_strip_prefs.cc",
            "registry->RegisterBooleanPref(prefs::kVerticalTabsEnabled, false);",
            "registry->RegisterBooleanPref(prefs::kVerticalTabsEnabled, true);")
    replace(root, "chrome/common/chrome_paths_linux.cc",
            'std::string data_dir_basename = "chromium";',
            'std::string data_dir_basename = "boybrowse";')
    branding = root / "chrome/app/theme/chromium/BRANDING"
    brand = branding.read_text().replace("PRODUCT_FULLNAME=Chromium", "PRODUCT_FULLNAME=Boybrowse")
    brand = brand.replace("PRODUCT_SHORTNAME=Chromium", "PRODUCT_SHORTNAME=Boybrowse")
    brand = brand.replace("PRODUCT_INSTALLER_FULLNAME=Chromium", "PRODUCT_INSTALLER_FULLNAME=Boybrowse")
    brand = brand.replace("PRODUCT_INSTALLER_SHORTNAME=Chromium", "PRODUCT_INSTALLER_SHORTNAME=Boybrowse")
    brand = brand.replace("MAC_BUNDLE_ID=org.chromium.Chromium", "MAC_BUNDLE_ID=net.freifick.boybrowse")
    branding.write_text(brand)
    # Grit message bodies contain whitespace and nested placeholders. Preserve
    # source structure, identifiers, URLs and upstream author attribution.
    strings = root / "chrome/app/chromium_strings.grd"
    strings.write_text(brand_strings(strings.read_text()))
    colors = """
  // Boybrowse native browser surfaces; forced colors below take precedence.
  mixer[ui::kColorFrameActive] = {SkColorSetRGB(0x36, 0x2b, 0x43)};
  mixer[ui::kColorFrameInactive] = {SkColorSetRGB(0x55, 0x47, 0x62)};
  mixer[kColorToolbar] = {dark_mode ? SkColorSetRGB(0x2a, 0x24, 0x34) : SkColorSetRGB(0xee, 0xe8, 0xf5)};
  mixer[kColorToolbarText] = {dark_mode ? SkColorSetRGB(0xf0, 0xe8, 0xf7) : SkColorSetRGB(0x30, 0x2a, 0x3b)};
  mixer[kColorToolbarButtonIcon] = {kColorToolbarText};
  mixer[kColorBookmarkBarBackground] = {kColorToolbar};
  mixer[kColorBookmarkBarForeground] = {kColorToolbarText};

"""
    replace(root, "chrome/browser/ui/color/chrome_color_mixer.cc",
            "  // Apply high contrast recipes if necessary.",
            colors + "  // Apply high contrast recipes if necessary.")
    shared = root / "ui/webui/resources/cr_elements/cr_shared_vars.css"
    with shared.open("a") as file:
        file.write("""
/* Boybrowse shared internal surfaces. Preserve forced colors. */
@media not (forced-colors: active) {
  html {
    --cr-card-border-radius: 16px;
    --cr-section-border-color: #d9d0e1;
    --cr-card-background-color: #fffdfa;
    --cr-primary-text-color: #302a3b;
    --cr-secondary-text-color: #706778;
    --cr-link-color: #8055a5;
    --cr-focus-outline-color: #8a58bf;
  }
}
@media (prefers-color-scheme: dark) and (not (forced-colors: active)) {
  html {
    --cr-card-background-color: #2a2434;
    --cr-primary-text-color: #f0e8f7;
    --cr-secondary-text-color: #b8abc6;
    --cr-section-border-color: #4a3e59;
    --cr-link-color: #c4a0e7;
  }
}
""")
    (root / "boybrowse-build.json").write_text(json.dumps({"chromium": VERSION, "revision": REVISION, "overlay": 1}, indent=2))

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: apply-chromium.py CHROMIUM_SOURCE BOYBROWSE_OVERLAY")
    apply(pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve())
