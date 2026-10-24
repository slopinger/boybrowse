#!/usr/bin/env python3
"""Render original Boybrowse SVG into Chromium's Linux and macOS icon resources."""
import pathlib
import re
import struct
import subprocess
import sys
import tempfile

def render(source, destination, width, height):
    subprocess.run(["rsvg-convert", "--width", str(width), "--height", str(height),
                    "--output", str(destination), str(source)], check=True)

def main(root, source):
    theme = root / "chrome/app/theme"
    count = 0
    for image in sorted(theme.rglob("product_logo_*.png")):
        if "chromium" not in image.relative_to(theme).parts:
            continue
        if not re.fullmatch(r"product_logo_\d+(?:_mono|_white)?\.png", image.name):
            continue
        original = image.read_bytes()
        if original[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"Unexpected PNG resource: {image}")
        width, height = struct.unpack(">II", original[16:24])
        render(source, image, width, height)
        count += 1
    if count < 8:
        raise RuntimeError("Chromium icon resource layout changed")
    (theme / "chromium/product_logo.svg").write_bytes(source.read_bytes())
    chunks = []
    with tempfile.TemporaryDirectory() as directory:
        for kind, size in [(b"ic07",128), (b"ic08",256), (b"ic09",512), (b"ic10",1024)]:
            image = pathlib.Path(directory) / f"{size}.png"
            render(source,image,size,size)
            data = image.read_bytes()
            chunks.append(kind + struct.pack(">I",len(data)+8) + data)
    data = b"".join(chunks)
    (theme / "chromium/mac/app.icns").write_bytes(b"icns" + struct.pack(">I",len(data)+8) + data)
    # Prefer our portable ICNS over Chromium's precompiled Tahoe asset catalog.
    plist = root / "chrome/app/app-Info.plist"
    before = "\t<key>CFBundleIconName</key>\n\t<string>AppIcon</string>\n"
    contents = plist.read_text()
    if contents.count(before) != 1:
        raise RuntimeError("Chromium app icon plist context changed")
    plist.write_text(contents.replace(before,""))
    print(f"Rendered {count} PNG icons and the macOS ICNS from the original SVG")

if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
