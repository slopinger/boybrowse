#!/usr/bin/env python3
"""Compare the pinned engine with Chrome's official stable release API."""
import base64
import concurrent.futures
import json
import re
import sys
import urllib.request

def version(text):
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", text):
        raise ValueError("Unexpected upstream version")
    return tuple(map(int,text.split(".")))

def latest(platform):
    address = "https://versionhistory.googleapis.com/v1/chrome/platforms/" + platform + "/channels/stable/versions?order_by=version%20desc"
    request = urllib.request.Request(address,headers={"User-Agent":"Boybrowse-upstream-check/1"})
    with urllib.request.urlopen(request,timeout=30) as response:
        data = json.load(response)
    versions = [row["version"] for row in data["versions"]]
    return platform,max(versions,key=version)

def version_only_bump(pinned,current):
    # Chrome sometimes publishes a Mac packaging patch whose only source change
    # is chrome/VERSION. Verify that exact direct-child relationship live; an
    # arbitrary higher version or any other file change must still fail.
    root = "https://chromium.googlesource.com/chromium/src/+/refs/tags/"
    def commit(tag):
        with urllib.request.urlopen(root + tag + "?format=JSON",timeout=30) as response:
            text = response.read().decode()
        if not text.startswith(")]}'\n"):
            raise ValueError("Unexpected Gitiles response")
        return json.loads(text[5:])
    old,new = commit(pinned),commit(current)
    changes = new.get("tree_diff",[])
    if new.get("parents") != [old["commit"]] or len(changes) != 1:
        return False
    change = changes[0]
    if change.get("type") != "modify" or change.get("old_path") != "chrome/VERSION" or change.get("new_path") != "chrome/VERSION":
        return False
    for tag in (pinned,current):
        with urllib.request.urlopen(root + tag + "/chrome/VERSION?format=TEXT",timeout=30) as response:
            contents = base64.b64decode(response.read(),validate=True).decode().strip()
        expected = "\n".join(f"{key}={part}" for key,part in zip(["MAJOR","MINOR","BUILD","PATCH"],version(tag)))
        if contents != expected:
            return False
    print("Verified version-only packaging bump: " + root + current)
    return True

def main(pinned):
    old = version(pinned)
    outdated = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        for platform,current in executor.map(latest,["linux","mac_arm64"]):
            print(f"{platform}: pinned={pinned} stable={current}")
            if version(current) > old and not version_only_bump(pinned,current):
                outdated = True
                print(f"::error::{platform} has a newer stable engine. Update the pinned source and rerun native validation.")
    if outdated:
        return 1
    print("No newer engine source changes detected in the checked stable versions.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
