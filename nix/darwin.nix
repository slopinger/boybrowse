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
  sdk = pkgs.apple-sdk_26;
  gn = pkgs.gn.override sourceInfo.deps.gn;
  gclientArgs = "${nixpkgs}/pkgs/applications/networking/browsers/chromium/files/gclient_args.gni";
in pkgs.stdenv.mkDerivation {
  pname = "boybrowse";
  version = sourceInfo.version;
  nativeBuildInputs = [ python pkgs.nodejs pkgs.ninja gn pkgs.pkg-config pkgs.bison pkgs.gperf pkgs.nasm pkgs.perl pkgs.go pkgs.xz pkgs.zstd pkgs.npmHooks.npmConfigHook ];
  buildInputs = [ sdk ];
  npmDeps = upstream.npmDeps;
  npmRoot = "third_party/node";
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
    mkdir -p third_party/node/mac_arm64/bin
    ln -sf ${pkgs.nodejs}/bin/node third_party/node/mac_arm64/bin/node
    export BOYBROWSE_SDK="${sdk}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    export BOYBROWSE_SDK_VERSION="${sdk.version}"
    python3 ${../tools/prepare-darwin.py} ${builtins.toFile "chromium-info.json" (builtins.toJSON sourceInfo)}
    python3 ${../tools/apply-chromium.py} . ${overlay}/browser
    patchShebangs build tools third_party
  '';
  configurePhase = ''
    runHook preConfigure
    export RUSTC_BOOTSTRAP=1
    gn gen out/Release --args='is_debug=false is_official_build=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 target_cpu="arm64" target_os="mac" is_chrome_branded=false chrome_pgo_phase=0 use_remoteexec=false use_siso=false enable_nacl=false enable_widevine=false treat_warnings_as_errors=false use_lld=true'
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
