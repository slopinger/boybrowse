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
        nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.python3 ];
        postPatch = (old.postPatch or "") + ''
          ${pkgs.python3}/bin/python3 ${./tools/apply-chromium.py} . ${overlay}/browser
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
              --replace-fail "Exec=chromium" "Exec=boybrowse"
            mv $out/share/applications/chromium-browser.desktop $out/share/applications/boybrowse.desktop
          '';
        meta = old.meta // { mainProgram = "boybrowse"; description = "Boybrowse Chromium source fork"; };
        passthru = old.passthru // { inherit native; };
      });
    in { inherit pkgs perl server browser; };
  in {
    packages = each (system: let p = mk system; in {
      default = p.browser;
      boybrowse = p.browser;
      boybrowse-sync = p.server;
    });
    checks = each (system: let p = mk system; in {
      server = p.server;
      browser = p.browser;
      runtime = p.pkgs.runCommand "boybrowse-native-smoke" { nativeBuildInputs = [ p.pkgs.coreutils ]; } ''
        mkdir -p $out $TMPDIR/runtime
        chmod 700 $TMPDIR/runtime
        export XDG_RUNTIME_DIR=$TMPDIR/runtime
        # The outer Nix sandbox isolates this disposable test profile. Shipping
        # wrappers never pass --no-sandbox.
        timeout 120 ${p.browser}/bin/boybrowse --headless --no-sandbox --disable-gpu \
          --disable-dev-shm-usage --user-data-dir=$TMPDIR/profile \
          --virtual-time-budget=5000 --dump-dom chrome://boybrowse/ \
          > $out/dashboard.html 2> $out/browser.log
        grep -q 'data-decoration="full"' $out/dashboard.html
        grep -q 'Brain scraps' $out/dashboard.html
      '';
      integration = p.pkgs.runCommand "boybrowse-sync-integration" { nativeBuildInputs = [ p.pkgs.nodejs ]; } ''
        node ${self}/tests/integration.mjs ${p.server}
        touch $out
      '';
      javascript = p.pkgs.runCommand "boybrowse-javascript-tests" { nativeBuildInputs = [ p.pkgs.nodejs ]; } ''
        cd ${self}
        node --test tests/*.test.mjs
        touch $out
      '';
    });
    hydraJobs = nixpkgs.lib.genAttrs [ "browser" "server" "javascript" "integration" ]
      (name: nixpkgs.lib.genAttrs linuxSystems (system: self.checks.${system}.${name}));
    devShells = each (system: let p = mk system; in {
      default = p.pkgs.mkShell { packages = [ p.perl p.pkgs.nodejs p.pkgs.python3 p.pkgs.git ]; };
    });
    nixosModules.default = import ./nix/module.nix self;
  };
}
