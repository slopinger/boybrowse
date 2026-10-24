# Boybrowse development notes

Read /home/slop/CLAUDE.md. AGENTS.md links here. Public repository:
https://github.com/slopinger/boybrowse; origin only. Sign logical commits as slop;
never add Co-Authored-By trailers, session links, credentials, profiles, or test databases.

Boybrowse is a Chromium source overlay, not an Electron shell or a browser extension theme.
All builds and tests use the locked Nix flake, including macOS in GitHub Actions.
Linux architectures: x86_64 and aarch64. macOS target: aarch64. No Windows builds.

- browser/ contains the native WebUI bridge and dashboard. tools/apply-chromium.py
  requires the exact Chromium version from the pinned nixpkgs metadata and fails on
  changed patch contexts. Keep the version, revision, dependency hashes, and toolchain
  pins synchronized on upgrades.
- blocker/ is a bundled component using Chromium's declarative network filtering
  engine. Its public key fixes the extension ID; it is not a secret. The starter
  domain list updates with releases. Never silently fetch external lists.
- server/ contains the Perl Mojolicious API, DBI/SQLite storage and administrative CLI.
  Auth tokens and invitations are stored hashed; record contents and encryption keys
  must never appear in server state or logs. Runtime mode is production.
- Dashboard records persist in Boybrowse profile preferences. State generations reject
  stale window writes. Sync credentials use Chromium OSCrypt. Do not introduce a
  plaintext credential fallback.
- Sync records use WebCrypto AES-256-GCM (BoringSSL in Chromium), fresh nonces, record-ID
  associated data, and authenticated deletion markers. Maintain durable outbox retry,
  atomic batches and visible conflict copies. Private windows must never participate.
- Sync is manual/optional in this preview. Recovery kits and pairing kits contain
  secret material; never commit, log or retain them in documentation.
- Use `nix build .#boybrowse-sync` and
  `nix build .#checks.x86_64-linux.javascript .#checks.x86_64-linux.integration`
  for the fast checks. The integration check starts a real Perl HTTP server in
  the sandbox and exercises two clients. `nix build` compiles the complete browser.
- Full Chromium builds need substantial disk/time. Check disk before starting, use
  --cores 10 --max-jobs 2 on slopbox, and do not GC other sessions' roots.
- Native runtime verification must use the patched browser binary. Stock Chromium
  dashboard previews only verify page layout and frontend interactions.
- Hydra CI belongs on hydra.kyouma.net, project boybrowse, flake jobset main, managed
  through hydra-mcp. GitHub Actions owns macOS; it invokes Nix for every build/check.
- nix/server-test.nix boots the NixOS service and verifies loopback binding, restart,
  private state directories and the daily backup timer. Backups retain 30 days in
  /var/lib/boybrowse-sync-backups (same disk).
- Darwin HTTP tests require __darwinAllowLocalNetworking; this allows only local
  test sockets rather than disabling the Nix sandbox.
- Deploy the Perl server only through nixfiles after its tests pass; bind 127.0.0.1:8792.
  Intended domain boybrowse-sync.freifick.net; state /var/lib/boybrowse-sync/state.sqlite3.
  Keep README's deployment/build status accurate rather than claiming pending checks passed.
