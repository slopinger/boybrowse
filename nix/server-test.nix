{ pkgs, self }:
pkgs.testers.runNixOSTest {
  name = "boybrowse-sync-service";
  nodes.machine = { pkgs, ... }: {
    imports = [ self.nixosModules.default ];
    services.boybrowse-sync = { enable = true; backups.enable = true; };
    environment.systemPackages = [ pkgs.curl ];
    virtualisation.memorySize = 1024;
  };
  testScript = ''
    start_all()
    machine.wait_for_unit("boybrowse-sync.service")
    machine.wait_for_open_port(8792)
    machine.succeed("curl --fail http://127.0.0.1:8792/healthz | grep '\"status\":\"ok\"'")
    machine.succeed("ss -ltn | grep '127.0.0.1:8792'")
    machine.succeed("test $(stat -c %a /var/lib/boybrowse-sync) = 700")
    machine.succeed("systemctl start boybrowse-sync-backup.service")
    machine.succeed("find /var/lib/boybrowse-sync-backups -name '*.sqlite3' | grep .")
    machine.succeed("test $(stat -c %a /var/lib/boybrowse-sync-backups) = 700")
    machine.wait_for_unit("boybrowse-sync-backup.timer")
    machine.succeed("systemctl restart boybrowse-sync.service")
    machine.wait_for_open_port(8792)
    machine.succeed("curl --fail http://127.0.0.1:8792/healthz")
  '';
}
