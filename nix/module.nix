self: { config, lib, pkgs, ... }:
let cfg = config.services.boybrowse-sync; in {
  options.services.boybrowse-sync = {
    enable = lib.mkEnableOption "Boybrowse encrypted sync";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.boybrowse-sync;
      description = "Boybrowse Perl sync server package.";
    };
    port = lib.mkOption { type = lib.types.port; default = 8792; description = "Loopback HTTP port."; };
  };
  config = lib.mkIf cfg.enable {
    users.users.boybrowse-sync = { isSystemUser = true; group = "boybrowse-sync"; };
    users.groups.boybrowse-sync = {};
    systemd.services.boybrowse-sync = {
      description = "Boybrowse encrypted sync";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = { BOYBROWSE_DB = "/var/lib/boybrowse-sync/state.sqlite3"; MOJO_MODE = "production"; };
      serviceConfig = {
        User = "boybrowse-sync";
        Group = "boybrowse-sync";
        StateDirectory = "boybrowse-sync";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/boybrowse-sync";
        ExecStart = "${cfg.package}/bin/boybrowse-sync daemon -l http://127.0.0.1:${toString cfg.port}";
        Restart = "on-failure";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        CapabilityBoundingSet = "";
      };
    };
  };
}
