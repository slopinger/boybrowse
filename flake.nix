{
  description = "Boybrowse: a personal Chromium source fork and encrypted Perl sync";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/832ed04d7eda63307ca21cedf4975780acc00eb9";
  outputs = { self, nixpkgs }: let
    linuxSystems = [ "x86_64-linux" "aarch64-linux" ];
    systems = linuxSystems ++ [ "aarch64-darwin" ];
    each = nixpkgs.lib.genAttrs systems;
    mk = system: let
      pkgs = nixpkgs.legacyPackages.${system};
      perl = pkgs.perl.withPackages (p: [ p.Mojolicious p.DBI p.DBDSQLite p.CryptX ]);
      server = pkgs.stdenvNoCC.mkDerivation {
        pname = "boybrowse-sync";
        version = "0.1.0";
        src = ./server;
        nativeBuildInputs = [ pkgs.makeWrapper ];
        nativeCheckInputs = [ perl ];
        __darwinAllowLocalNetworking = true;
        dontBuild = true;
        doCheck = true;
        checkPhase = "prove -Ilib -v t";
        installPhase = ''
          mkdir -p $out/share/boybrowse-sync $out/bin
          cp -r lib boybrowse-sync boybrowse-syncctl $out/share/boybrowse-sync/
          for tool in boybrowse-sync boybrowse-syncctl; do
            makeWrapper ${perl}/bin/perl $out/bin/$tool \
              --add-flags "$out/share/boybrowse-sync/$tool"
          done
        '';
        meta = {
          license = pkgs.lib.licenses.mit;
          mainProgram = "boybrowse-sync";
          platforms = systems;
        };
      };
      overlay = pkgs.lib.fileset.toSource { root = ./.; fileset = pkgs.lib.fileset.unions [ ./browser ./blocker ]; };
      sourceInfo = (builtins.fromJSON (builtins.readFile "${nixpkgs}/pkgs/applications/networking/browsers/chromium/info.json")).chromium;
      native = pkgs.chromium.browser.overrideAttrs (old: {
        name = "boybrowse-browser";
        nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.python3 pkgs.librsvg ];
        postPatch = (old.postPatch or "") + ''
          ${pkgs.python3}/bin/python3 ${./tools/apply-chromium.py} . ${overlay}/browser
          ${pkgs.python3}/bin/python3 ${./tools/brand-icons.py} . ${overlay}/browser/ui/icon.svg
        '';
        installPhase = old.installPhase +  ''
          cp -r ${./blocker} $out/libexec/chromium/resources/boybrowse_blocker
          cp boybrowse-build.json $out/libexec/chromium/
        '';
        meta = old.meta // { description = "Boybrowse Chromium source fork"; };
      });
      browser = if pkgs.stdenv.hostPlatform.isDarwin then
        import ./nix/darwin.nix { inherit pkgs nixpkgs overlay sourceInfo; }
      else pkgs.chromium.overrideAttrs (old: {
        pname = "boybrowse";
        buildCommand = builtins.replaceStrings
          [ (toString pkgs.chromium.browser) ] [ (toString native) ]
          old.buildCommand + ''
            mv $out/bin/chromium $out/bin/boybrowse
            rm $out/bin/chromium-browser
            substituteInPlace $out/bin/boybrowse \
              --replace-fail "CHROME_WRAPPER='chromium'" "CHROME_WRAPPER='boybrowse'"
            rm $out/share/applications
            cp -r ${native}/share/applications $out/share/applications
            chmod -R u+w $out/share/applications
            substituteInPlace $out/share/applications/chromium-browser.desktop \
              --replace-fail "Name=Chromium" "Name=Boybrowse" \
              --replace-fail "Exec=chromium" "Exec=boybrowse" \
              --replace-fail "Icon=chromium" "Icon=boybrowse"
            mv $out/share/applications/chromium-browser.desktop $out/share/applications/boybrowse.desktop
            rm $out/share/icons
            cp -r ${native}/share/icons $out/share/icons
            chmod -R u+w $out/share/icons
            for icon in $out/share/icons/hicolor/*/apps/chromium.png; do
              mv "$icon" "$(dirname "$icon")/boybrowse.png"
            done
          '';
        meta = old.meta // { mainProgram = "boybrowse"; description = "Boybrowse Chromium source fork"; };
        passthru = old.passthru // { inherit native; };
      });
      nativeCheck = native.overrideAttrs (old: {
        name = "boybrowse-native-compile-check";
        outputs = [ "out" ];
        buildPhase = ''
          ninja -C out/Release -j$NIX_BUILD_CORES obj/chrome/browser/ui/webui/boybrowse/boybrowse/boybrowse_ui.o
        '';
        installPhase = ''
          mkdir -p $out
          cp out/Release/obj/chrome/browser/ui/webui/boybrowse/boybrowse/boybrowse_ui.o $out/
        '';
        dontFixup = true;
      });
    in { inherit pkgs perl server browser nativeCheck; };
  in {
    packages = each (system: let p = mk system; in {
      default = p.browser;
      boybrowse = p.browser;
      boybrowse-sync = p.server;
    } // nixpkgs.lib.optionalAttrs (system != "aarch64-darwin") { native-check = p.nativeCheck; });
    checks = each (system: let p = mk system; in ({
      server = p.server;
      browser = p.browser;
      runtime = p.pkgs.runCommand "boybrowse-native-runtime" {
        nativeBuildInputs = [ p.pkgs.nodejs p.pkgs.coreutils ];
        __darwinAllowLocalNetworking = true;
      } ''
        mkdir -p $out $TMPDIR/runtime
        chmod 700 $TMPDIR/runtime
        export XDG_RUNTIME_DIR=$TMPDIR/runtime
        # The outer Nix sandbox isolates this disposable test profile. Shipping
        # wrappers never pass --no-sandbox.
        timeout 300 node ${self}/tests/native-runtime.mjs ${p.browser}/bin/boybrowse $out
      '';
      integration = p.pkgs.runCommand "boybrowse-sync-integration" { nativeBuildInputs = [ p.pkgs.nodejs ]; __darwinAllowLocalNetworking = true; } ''
        node ${self}/tests/integration.mjs ${p.server}
        touch $out
      '';
      tooling = p.pkgs.runCommand "boybrowse-source-tooling-tests" { nativeBuildInputs = [ p.pkgs.python3 ]; } ''
        export PYTHONDONTWRITEBYTECODE=1
        python3 ${self}/tests/test_patch_tools.py
        touch $out
      '';
      javascript = p.pkgs.runCommand "boybrowse-javascript-tests" { nativeBuildInputs = [ p.pkgs.nodejs ]; } ''
        cd ${self}
        for script in browser/ui/*.mjs tests/*.mjs; do node --check "$script"; done
        node --test tests/*.test.mjs
        touch $out
      '';
    }) // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
      nixos = import ./nix/server-test.nix { inherit self; pkgs = p.pkgs; };
    });
    hydraJobs = (nixpkgs.lib.genAttrs [ "browser" "runtime" "server" "javascript" "integration" "tooling" ]
      (name: nixpkgs.lib.genAttrs linuxSystems (system: self.checks.${system}.${name}))) // {
        nixos.x86_64-linux = self.checks.x86_64-linux.nixos;
      };
    devShells = each (system: let p = mk system; in {
      default = p.pkgs.mkShell { packages = [ p.perl p.pkgs.nodejs p.pkgs.python3 p.pkgs.git ]; };
    });
    nixosModules.default = import ./nix/module.nix self;
  };
}
