# Boybrowse

A personal Chromium source fork. Lavender browser chrome, a very large hoodie, and
a little room for your next rabbit hole. Built for slop, she/her.

**Development preview.** The complete browser is being built and validated.
Source availability, passing protocol tests, and successful platform browser builds
are separate milestones; see the build matrix below.

## What is here

- Native Chromium source patches: Boybrowse branding and separate profile paths,
  lavender/charcoal browser surfaces, shared internal-page styling, vertical tabs by
  default, and a custom privileged `chrome://boybrowse/` interface.
- A personal start page, window tab management, two-tab split view, searchable commands,
  persistent workspace collections, local Markdown notes, appearance controls, and
  links to Chromium's reader, performance, permission and privacy controls.
- Bundled Boybrowse Shields: Chromium's declarative request filtering engine with
  a 30-domain third-party advertising/tracking starter list and local site exceptions.
  This preview does not include cosmetic filtering or automatic filter downloads.
- Optional invite-only encrypted sync with a Perl server. The server cannot read
  note content, workspace names or URLs. It can see account/device metadata, record
  sizes and timing; it can deny service or suppress updates.

This is a source fork built by applying a maintained overlay to pinned Chromium.
It preserves Chromium's engine, sandbox and site isolation. No Chrome binaries or
Google Chrome branding are redistributed.

## Build everything with Nix

```sh
nix build                         # native browser, current supported system
nix run                          # Boybrowse
nix build .#boybrowse-sync        # Perl server, including its tests
nix build .#checks.x86_64-linux.javascript
nix build .#checks.x86_64-linux.integration
nix develop                      # pinned Perl, Node, Python, git
```

Supported build targets: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`.
macOS is built by Nix on GitHub Actions; the SDK and Chromium toolchain archives
are pinned inputs. Windows builds are excluded. Chromium's extensive source
dependencies are fixed-output inputs; compilation has no network access.

The default Linux package builds Chromium from source and is expensive. Allow at
least 100 GiB of available disk, plus headroom for Nix inputs, and hours of build
time. Do not mistake cached upstream Chromium for a completed Boybrowse build.

### Build matrix

| Check | Current evidence |
|---|---|
| Perl API/storage tests | 115 assertions pass in the Nix sandbox |
| JavaScript model/crypto/sync tests | 8 tests pass in the Nix sandbox |
| Real Perl HTTP integration | Pass: two clients, conflicts, isolation, revocation, recovery, backup |
| Dashboard layout | Desktop preview visually inspected; native runtime validation pending |
| Linux source browser | Build in progress; no working binary claimed |
| Linux ARM64 browser | Hydra build pending |
| macOS ARM64 browser | Nix expression evaluates; native build/launch validation pending |

Workspaces currently save and reopen collections rather than hiding live tabs by
workspace. Chromium's existing settings/history/downloads pages retain their
upstream structure with shared Boybrowse styling. Native bookmark/open-tab sync,
full browser automation, platform runtime checks and release validation remain
under development. These are required parts of the intended release.

## Sync

The browser generates an account key and encrypts records with AES-256-GCM using
fresh nonces and authenticated record IDs. The Perl server stores opaque
ciphertexts, hashed bearer credentials, revisions, and tombstones. Deletion
markers are authenticated inside the encrypted envelope. Conflicting offline
edits keep a visible copy; a durable outbox makes interrupted batches retryable.

Settings, notes, and saved workspaces use the encrypted record layer. Native
bookmarks and per-device open-tab capture are being connected to it. Passwords,
cookies, browsing history, and incognito data remain device-local.

Create an invitation with `boybrowse-syncctl invite` on the server, connect through
the browser, then save the generated recovery kit somewhere private. Pairing kits
expire after ten minutes. Recovery rotates authentication and revokes existing
devices; it does not recover encryption keys from the server. Losing the account
key and every trusted device loses access to encrypted data.

Preview sync requires explicit actions. There is no Google account integration,
cloud AI, or automatic diagnostics upload.

### Server deployment

The flake exports `nixosModules.default` with `services.boybrowse-sync.enable`,
`package`, and `port` options. The daemon binds loopback only. Configure Caddy
and DNS through your host's NixOS flake.

Planned local deployment: `https://boybrowse-sync.freifick.net`, loopback port 8792,
state `/var/lib/boybrowse-sync/state.sqlite3`. Deployment and backup scheduling
are still being completed; this is not a live-service claim.

```sh
BOYBROWSE_DB=/path/to/state.sqlite3 boybrowse-sync daemon -l http://127.0.0.1:8792
BOYBROWSE_DB=/path/to/state.sqlite3 boybrowse-syncctl invite
BOYBROWSE_DB=/path/to/state.sqlite3 boybrowse-syncctl backup /private/backup.sqlite3
```

`backup` uses SQLite's online backup API and verifies the result. Tests restore a
copy and verify authorization and integrity. Never copy a live SQLite database
without accounting for its WAL.

## License

Original Boybrowse code: MIT. Chromium and its dependencies retain their upstream
licenses and notices. The hoodie drawing is original SVG artwork.
