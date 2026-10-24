use strict;
use warnings;
use Test::More;
use Test::Mojo;
use File::Temp qw(tempdir);
use Boybrowse::Sync;
use Boybrowse::Store;

my $dir = tempdir(CLEANUP => 1);
$ENV{BOYBROWSE_DB} = "$dir/state.sqlite3";
my $app = Boybrowse::Sync->new;
my $t = Test::Mojo->new($app);
my $s = $app->store;
$t->get_ok('/healthz')->status_is(200)->json_is('/protocol', 1);
$t->get_ok('/v1/records')->status_is(401);
$t->options_ok('/v1/records' => {Origin => 'chrome://boybrowse'})->status_is(204)
  ->header_is('Access-Control-Allow-Origin', 'chrome://boybrowse');
$t->get_ok('/v1/records' => {Origin => 'https://evil.example'})->status_is(403);
$t->post_ok('/v1/enroll' => json => {invitation => 'bad', name => 'laptop'})->status_is(400);

sub enroll {
  my ($invite, $name) = @_;
  $t->post_ok('/v1/enroll' => json => {invitation => $invite, name => $name})->status_is(201);
  return $t->tx->res->json;
}
my $invite = $s->invite;
my $a = enroll($invite, 'laptop');
my $auth = {Authorization => "Bearer $a->{token}"};
$t->post_ok('/v1/enroll' => json => {invitation => $invite, name => 'replay'})->status_is(401);
my $b = enroll($s->invite, 'other account');
my $other = {Authorization => "Bearer $b->{token}"};
my $id = 'a' x 32;
my $batch = {operation => '1' x 32, records => [{id => $id, base => 0, deleted => 0, ciphertext => 'Z' x 80}]};
$t->post_ok('/v1/records' => $auth => json => $batch)->status_is(200)->json_is('/revision', 1);
$t->post_ok('/v1/records' => $auth => json => $batch)->status_is(200)->json_is('/revision', 1);
$t->get_ok('/v1/records?cursor=0' => $auth)->status_is(200)->json_is('/records/0/ciphertext', 'Z' x 80)->json_is('/cursor', 1);
$t->get_ok('/v1/records' => $other)->status_is(200)->json_is('/records', []);
$t->post_ok('/v1/records' => $auth => json => {operation => '2' x 32, records => $batch->{records}})->status_is(409);
$t->post_ok('/v1/records' => $auth => json => {operation => '1' x 32, records => [{id => $id, base => 1, deleted => 1, ciphertext => 'D' x 80}]})->status_is(409);
# A conflict aborts the entire batch.
$t->post_ok('/v1/records' => $auth => json => {operation => '3' x 32, records => [
  {id => 'b' x 32, base => 0, deleted => 0, ciphertext => 'Q' x 80},
  {id => $id, base => 0, deleted => 1, ciphertext => 'D' x 80}
]})->status_is(409);
$t->get_ok('/v1/records' => $auth)->json_is('/records/0/id', $id)->json_is('/records/1', undef);
$t->post_ok('/v1/records' => $auth => json => {operation => '4' x 32, records => [{id => $id, base => 1, deleted => 1, ciphertext => 'D' x 80}]})->status_is(200)->json_is('/revision', 2);
$t->get_ok('/v1/records?cursor=1' => $auth)->json_is('/records/0/deleted', 1)->json_is('/records/0/ciphertext', 'D' x 80);
$t->get_ok('/v1/records?cursor=-1' => $auth)->status_is(400);
$t->post_ok('/v1/records' => $auth => json => {operation => '5' x 32, records => [{id => $id, base => 2, deleted => 0, ciphertext => 'https://plaintext.invalid'}]})->status_is(400);
$t->post_ok('/v1/pair' => $auth)->status_is(201);
my $paired = enroll($t->tx->res->json->{invitation}, 'desktop');
is($paired->{account}, $a->{account}, 'pairing stays in account');
ok(!exists $paired->{recovery}, 'pairing does not reveal recovery token');
my $paired_auth = {Authorization => "Bearer $paired->{token}"};
$t->get_ok('/v1/devices' => $paired_auth)->status_is(200);
is(scalar @{$t->tx->res->json->{devices}}, 2, 'two devices');
$t->delete_ok("/v1/devices/$paired->{device}" => $other)->status_is(204);
$t->get_ok('/v1/records' => $paired_auth)->status_is(200);
$t->delete_ok("/v1/devices/$paired->{device}" => $auth)->status_is(204);
$t->get_ok('/v1/records' => $paired_auth)->status_is(401);
$t->post_ok('/v1/recover' => json => {account => $a->{account}, recovery => $a->{recovery}, name => 'recovered'})->status_is(200);
my $recovered = $t->tx->res->json;
$t->get_ok('/v1/records' => $auth)->status_is(401);
$t->post_ok('/v1/recover' => json => {account => $a->{account}, recovery => $a->{recovery}, name => 'replay'})->status_is(401);
$t->delete_ok('/v1/account' => {Authorization => "Bearer $recovered->{token}"} => json => {confirm => 'delete my account'})->status_is(204);
$t->get_ok('/v1/records' => {Authorization => "Bearer $recovered->{token}"})->status_is(401);
is($s->db->selectrow_array('SELECT count(*) FROM records WHERE account=?', undef, $a->{account}), 0, 'account deletion cascades');
my $expired = $s->invite(undef, -10);
$t->post_ok('/v1/enroll' => json => {invitation => $expired, name => 'expired'})->status_is(401);
# Quota rejection does not allocate a revision or partially write.
$t->post_ok('/v1/records' => $other => json => {operation => '6' x 32, records => [
  {id => 'f' x 32, base => 0, deleted => 0, ciphertext => 'a' x 349529}
]})->status_is(400);
# Verify WAL-aware backup and restore including authentication.
my $backup = "$dir/backup.sqlite3";
$s->db->sqlite_backup_to_file($backup);
my $restored = Boybrowse::Store->new($backup);
ok($restored->authorize($b->{token}), 'backup restores device authorization');
is($restored->db->selectrow_array('PRAGMA integrity_check'), 'ok', 'restored database integrity');
for (1..30) { ok($s->rate('isolated-limit', 30), 'allowed request') }
ok(!$s->rate('isolated-limit', 30), 'rate limit enforced');
done_testing;
