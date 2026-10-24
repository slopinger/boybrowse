{ pkgs, nixpkgs, overlay, sourceInfo }:
let
  lib = pkgs.lib;
  upstream = nixpkgs.legacyPackages.x86_64-linux.chromium.browser;
  deps = upstream.chromiumDeps;
  clangArchive = pkgs.fetchurl {
    url = "https://commondatastorage.googleapis.com/chromium-browser-clang/Mac_arm64/clang-llvmorg-24-init-7747-g62397f8b-53.tar.xz";
    hash = "sha256-fOAVzel0/DK7gOH0iqfd29y+RP1vhhTeXmPK5HM5YNU=";
  };
  rustArchive = pkgs.fetchurl {
    url = "https://commondatastorage.googleapis.com/chromium-browser-clang/Mac_arm64/rust-toolchain-1edd55dcfcd573872c727fa3e086369a71661ee0-2-llvmorg-24-init-7747-g62397f8b.tar.xz";
    hash = "sha256-XbIf/UkJzoLAgy350esGsBsVpUF2tzQeOfcYH0tIPbw=";
  };
  python = pkgs.python3.withPackages (p: [ p.jinja2 p.markupsafe p.ply p.six p.setuptools p.packaging ]);
  # Match the pinned DevTools npm dependency, as the Linux Chromium derivation does.
  esbuild = pkgs.buildGoModule rec {
    pname = "esbuild";
    version = "0.28.2";
    src = pkgs.fetchFromGitHub {
      owner = "evanw";
      repo = "esbuild";
      tag = "v${version}";
      hash = "sha256-I1u+9U5Oj/KzxSjCxwyitwSuDKimatkbC3R2OtaUsfM=";
    };
    vendorHash = "sha256-+BfxCyg0KkDQpHt/wycy/8CTG6YBA/VJvJFhhzUnSiQ=";
    subPackages = [ "cmd/esbuild" ];
  };
  sdk = pkgs.apple-sdk_26;
  gn = pkgs.gn.override sourceInfo.deps.gn;
  gclientArgs = "${nixpkgs}/pkgs/applications/networking/browsers/chromium/files/gclient_args.gni";
in pkgs.stdenv.mkDerivation {
  pname = "boybrowse";
  version = sourceInfo.version;
  nativeBuildInputs = [ python pkgs.nodejs pkgs.ninja gn pkgs.pkg-config pkgs.bison pkgs.gperf pkgs.nasm pkgs.perl pkgs.go pkgs.xz pkgs.zstd pkgs.librsvg pkgs.npmHooks.npmConfigHook ];
  buildInputs = [ sdk ];
  npmDeps = upstream.npmDeps;
  npmRoot = "third_party/node";
  patches = [
    # CL 7457194 references CIPD-only finch seeds that source tarballs lack; nixpkgs reverts it on Linux too.
    (pkgs.fetchpatch {
      name = "chromium-146-revert-Add-finch-seeds-to-desktop-perf-builds.patch";
      url = "https://chromium.googlesource.com/chromium/src/+/d2e8a550eece6051372da94a475a8661da203106^!?format=TEXT";
      decode = "base64 -d";
      revert = true;
      hash = "sha256-tJ//HE7o9R8nSQDGhi+MKXdNUwnkCZI++CzpAmFn2YY=";
    })
  ];
  unpackPhase = ''
    runHook preUnpack
    mkdir src
    tar --zstd -xf ${deps.src} -C src
    ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: source:
      lib.optionalString (name != "src") ''
        mkdir -p ${lib.escapeShellArg name}
        cp -R ${source}/. ${lib.escapeShellArg name}
        chmod -R u+w ${lib.escapeShellArg name}
      '') deps)}
    chmod -R u+w src
    sourceRoot=src
    runHook postUnpack
  '';
  postPatch = ''
    cp ${gclientArgs} build/config/gclient_args.gni
    chmod u+w build/config/gclient_args.gni
    mkdir -p third_party/llvm-build/Release+Asserts third_party/rust-toolchain
    tar -xf ${clangArchive} -C third_party/llvm-build/Release+Asserts
    tar -xf ${rustArchive} -C third_party/rust-toolchain
    # mac_bin_path points here: Chromium looks up gperf and libtool next to the LLVM tools.
    mkdir -p third_party/llvm-build/Release+Asserts/bin
    ln -sf ${pkgs.gperf}/bin/gperf third_party/llvm-build/Release+Asserts/bin/gperf
    ln -sf ${pkgs.cctools}/bin/libtool third_party/llvm-build/Release+Asserts/bin/libtool
    mkdir -p third_party/node/mac_arm64/node-darwin-arm64/bin
    ln -sf ${pkgs.nodejs}/bin/node third_party/node/mac_arm64/node-darwin-arm64/bin/node
    mkdir -p third_party/typescript/mac-arm64/src third_party/devtools-frontend/src/third_party/esbuild third_party/gperf/cipd/bin
    cp -R ${pkgs.typescript}/lib/typescript third_party/typescript/mac-arm64/src/lib
    chmod -R u+w third_party/typescript/mac-arm64/src/lib
    patch --strip=1 --directory=third_party/typescript/mac-arm64/src --input=../3pp/patches/typescript_native_preview.patch
    ln -sf ${esbuild}/bin/esbuild third_party/devtools-frontend/src/third_party/esbuild/esbuild
    ln -sf ${pkgs.gperf}/bin/gperf third_party/gperf/cipd/bin/gperf
    export BOYBROWSE_SDK="${sdk}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    export BOYBROWSE_SDK_VERSION="${sdk.version}"
    python3 ${../tools/prepare-darwin.py} ${builtins.toFile "chromium-info.json" (builtins.toJSON sourceInfo)}
    python3 ${../tools/apply-chromium.py} . ${overlay}/browser
    python3 ${../tools/brand-icons.py} . ${overlay}/browser/ui/icon.svg
    patchShebangs build tools third_party
  '';
  configurePhase = ''
    runHook preConfigure
    export RUSTC_BOOTSTRAP=1
    # Same node_modules fixes as nixpkgs' Chromium preConfigure: apply Chromium's npm patches and drop
    # packages whose duplicate typings break the TypeScript steps (TS2403, TS2352).
    (cd third_party/node && grep patch update_npm_deps | sh)
    rm -r third_party/node/node_modules/@lit/reactive-element/development
    rm -r third_party/node/node_modules/@types/estree
    # A silent GN hang once burned two hours of macOS CI. GN's piped output is block-buffered and lost
    # when it is killed, so run it on a pty (line-buffered, streams into the log) and, on a stall,
    # report the process tree and a stack sample before failing.
    # use_unified_system_module=false (as nixpkgs does for Linux): otherwise build/modules/BUILD.gn
    # expand_directory()s the whole Nix SDK sysroot recursively and gn spins at 100% CPU for hours.
    python3 -c 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)' gn gen --verbose --time out/Release --args='is_debug=false is_official_build=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 target_cpu="arm64" target_os="mac" use_system_xcode=false is_chrome_branded=false chrome_pgo_phase=0 use_remoteexec=false use_siso=false enable_nacl=false enable_widevine=false use_typescript_go=false devtools_use_typescript_go=false treat_warnings_as_errors=false use_lld=true use_clang_modules=false use_unified_system_module=false v8_use_metagen_instance_types=false' &
    gn_pid=$!
    for _ in $(seq 30); do
      sleep 10
      kill -0 $gn_pid 2>/dev/null || break
    done
    if kill -0 $gn_pid 2>/dev/null; then
      echo "gn gen stalled after 5 minutes; process tree:"
      /bin/ps -axo pid,ppid,etime,command 2>&1 | grep -v grep | grep -E "gn|python|node|rustc|clang|PID" || true
      /usr/bin/sample gn 5 -file gn-sample.txt 2>&1 | tail -3 || true
      head -80 gn-sample.txt 2>/dev/null || true
      kill -9 $gn_pid
      exit 1
    fi
    wait $gn_pid
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    ninja -C out/Release -j$NIX_BUILD_CORES chrome
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications $out/bin
    cp -R out/Release/Boybrowse.app $out/Applications/
    framework="$out/Applications/Boybrowse.app/Contents/Frameworks/Boybrowse Framework.framework/Versions/${sourceInfo.version}"
    cp -R ${../blocker} "$framework/Resources/boybrowse_blocker"
    cp boybrowse-build.json $out/
    ln -s "$out/Applications/Boybrowse.app/Contents/MacOS/Boybrowse" $out/bin/boybrowse
    runHook postInstall
  '';
  dontStrip = true;
  meta = {
    description = "Boybrowse Chromium source fork";
    license = [ lib.licenses.bsd3 lib.licenses.mit ];
    mainProgram = "boybrowse";
    platforms = [ "aarch64-darwin" ];
    timeout = 172800;
  };
}
