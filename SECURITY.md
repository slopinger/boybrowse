# Security and engine updates

Boybrowse is a development preview. A passing protocol suite is not evidence that
the native browser builds or runs on a platform; README records those milestones.

The daily upstream watch uses Chrome's official [VersionHistory API](https://developer.chrome.com/docs/web-platform/versionhistory/reference)
for Linux and macOS ARM64. Run it manually with `nix run .#upstream-check`.
It fails when a stable release has newer source changes than the pinned engine.
A direct-child tag that changes only the four-field chrome/VERSION file is reported
as a packaging-only bump after live verification against Chromium's Gitiles API;
any other change still fails. The watch does not apply upgrades or certify the
absence of vulnerabilities.

To update the engine, update the nixpkgs input and lock, then synchronize the
version/revision guard in tools/apply-chromium.py, Darwin toolchain hashes and
preparation metadata. Review every changed patch context. Build the browser and
run protocol, NixOS VM and native runtime checks on the supported platforms before
publishing an artifact. Never bypass a failed patch-context check.

The sync design authenticates each record and deletion marker with AES-256-GCM;
clients retain the account key. Recovery revokes device credentials but cannot
recover a lost encryption key. Tokens in SQLite are hashed. Server metadata and
traffic sizes remain visible. Passwords, cookies, history and private-window data
are excluded from sync. Local notes and bookmarks are ordinary profile data; only
sync credentials use Chromium's OS credential protection. No plaintext credential
fallback is accepted when the OS protector is unavailable.

The service listens on loopback behind HTTPS. Its online SQLite backups are
verified and retained for 30 days on the host's disk. They preserve encrypted
records and hashed authentication state; same-disk backups do not survive losing
the host disk.
