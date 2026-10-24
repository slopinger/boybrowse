package Boybrowse::Store;
use strict;
use warnings;
use DBI;
use Digest::SHA qw(sha256_hex);
use Mojo::JSON qw(encode_json decode_json);
use JSON::PP ();
use Crypt::PRNG qw(random_bytes);
use MIME::Base64 qw(encode_base64url);
use File::Path qw(make_path);
use File::Basename qw(dirname);

sub token { encode_base64url(random_bytes(32)) }
sub id { unpack 'H*', random_bytes(16) }
sub new {
  my ($class, $path) = @_;
  make_path(dirname($path), {mode => 0700}) unless -d dirname($path);
  my $db = DBI->connect("dbi:SQLite:dbname=$path", '', '',
    {RaiseError => 1, PrintError => 0, AutoCommit => 1, sqlite_unicode => 1});
  $db->do('PRAGMA foreign_keys=ON');
  $db->do('PRAGMA busy_timeout=5000');
  $db->do('PRAGMA journal_mode=WAL');
  $db->do($_) for (
    'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, recovery TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS invitations (token TEXT PRIMARY KEY, account TEXT REFERENCES accounts(id) ON DELETE CASCADE, expires INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS records (account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY(account,id))',
    'CREATE INDEX IF NOT EXISTS record_cursor ON records(account,revision)',
    'CREATE TABLE IF NOT EXISTS operations (account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(account,id))',
    'CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)',
    'PRAGMA user_version=1'
  );
  chmod 0600, $path;
  bless {db => $db}, $class;
}
sub db { $_[0]->{db} }
sub transaction {
  my ($self, $cb) = @_;
  my $db = $self->db;
  $db->do('BEGIN IMMEDIATE');
  my $result;
  eval { $result = $cb->($db); $db->do('COMMIT'); 1 } or do {
    my $error = $@; eval { $db->do('ROLLBACK') }; die $error;
  };
  return $result;
}
sub invite {
  my ($self, $account, $ttl) = @_;
  my $secret = token();
  $self->db->do('DELETE FROM invitations WHERE expires < ?', undef, time);
  $self->db->do('INSERT INTO invitations VALUES (?,?,?)', undef,
    sha256_hex($secret), $account, time + ($ttl // 86400));
  return $secret;
}
sub enroll {
  my ($self, $invite, $name) = @_;
  $self->transaction(sub {
    my ($db) = @_;
    my $row = $db->selectrow_hashref('SELECT * FROM invitations WHERE token=? AND expires>?', undef, sha256_hex($invite), time);
    return undef unless $row;
    my $account = $row->{account};
    my $recovery;
    unless ($account) {
      $account = id(); $recovery = token();
      $db->do('INSERT INTO accounts(id,recovery) VALUES (?,?)', undef, $account, sha256_hex($recovery));
    }
    my ($count) = $db->selectrow_array('SELECT count(*) FROM devices WHERE account=?', undef, $account);
    die "device limit\n" if $count >= 20;
    my $device = id(); my $secret = token();
    $db->do('INSERT INTO devices VALUES (?,?,?,?,?)', undef, $device, $account, $name, sha256_hex($secret), time);
    $db->do('DELETE FROM invitations WHERE token=?', undef, sha256_hex($invite));
    return {account => $account, device => $device, token => $secret,
      defined($recovery) ? (recovery => $recovery) : ()};
  });
}
sub authorize {
  my ($self, $secret) = @_;
  $self->db->selectrow_hashref('SELECT id,account FROM devices WHERE token=?', undef, sha256_hex($secret));
}
sub rate {
  my ($self, $key, $maximum) = @_;
  my $window = int(time / 60);
  $self->transaction(sub {
    my ($db) = @_;
    $db->do('DELETE FROM limits WHERE window < ?', undef, $window - 1);
    $db->do('INSERT INTO limits VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END, window=excluded.window', undef, sha256_hex($key), $window);
    my ($count) = $db->selectrow_array('SELECT count FROM limits WHERE key=?', undef, sha256_hex($key));
    return $count <= $maximum;
  });
}
sub push {
  my ($self, $account, $operation, $records) = @_;
  my $digest = sha256_hex(JSON::PP->new->canonical->encode($records));
  $self->transaction(sub {
    my ($db) = @_;
    my $old = $db->selectrow_hashref('SELECT digest,response FROM operations WHERE account=? AND id=?', undef, $account, $operation);
    return $old->{digest} eq $digest ? [200, decode_json($old->{response})] : [409, {error => 'operation_reused'}] if $old;
    my @conflicts;
    for my $record (@$records) {
      my ($revision) = $db->selectrow_array('SELECT revision FROM records WHERE account=? AND id=?', undef, $account, $record->{id});
      push @conflicts, $record->{id} if ($revision // 0) != $record->{base};
    }
    return [409, {error => 'conflict', records => \@conflicts}] if @conflicts;
    my ($size, $count) = $db->selectrow_array('SELECT coalesce(sum(length(ciphertext)),0),count(*) FROM records WHERE account=?', undef, $account);
    for my $record (@$records) {
      my ($previous) = $db->selectrow_array('SELECT length(ciphertext) FROM records WHERE account=? AND id=?', undef, $account, $record->{id});
      $count++ unless defined $previous;
      $size += length($record->{ciphertext}) - ($previous // 0);
    }
    return [413, {error => 'quota'}] if $size > 50 * 1024 * 1024 || $count > 10000;
    my ($revision) = $db->selectrow_array('SELECT revision FROM accounts WHERE id=?', undef, $account);
    my @written;
    for my $record (@$records) {
      ++$revision;
      $db->do('INSERT INTO records VALUES (?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,ciphertext=excluded.ciphertext', undef,
        $account, $record->{id}, $revision, $record->{deleted} ? 1 : 0, $record->{ciphertext});
      push @written, {id => $record->{id}, revision => $revision};
    }
    $db->do('UPDATE accounts SET revision=? WHERE id=?', undef, $revision, $account);
    my $result = {revision => $revision, records => \@written};
    $db->do('INSERT INTO operations VALUES (?,?,?,?)', undef, $account, $operation, $digest, encode_json($result));
    # Retain 1000 idempotency receipts per account; clients must pull before retrying older operations.
    $db->do('DELETE FROM operations WHERE account=? AND rowid NOT IN (SELECT rowid FROM operations WHERE account=? ORDER BY rowid DESC LIMIT 1000)', undef, $account, $account);
    return [200, $result];
  });
}
sub pull {
  my ($self, $account, $cursor) = @_;
  my $rows = $self->db->selectall_arrayref('SELECT id,revision,deleted,ciphertext FROM records WHERE account=? AND revision>? ORDER BY revision LIMIT 100', {Slice => {}}, $account, $cursor);
  return {records => $rows, cursor => @$rows ? $rows->[-1]{revision} : $cursor, more => @$rows == 100 ? 1 : 0};
}
sub recover {
  my ($self, $account, $recovery, $name) = @_;
  $self->transaction(sub {
    my ($db) = @_;
    my ($match) = $db->selectrow_array('SELECT id FROM accounts WHERE id=? AND recovery=?', undef, $account, sha256_hex($recovery));
    return undef unless $match;
    my $next = token(); my $secret = token(); my $device = id();
    $db->do('DELETE FROM devices WHERE account=?', undef, $account);
    $db->do('DELETE FROM invitations WHERE account=?', undef, $account);
    $db->do('UPDATE accounts SET recovery=? WHERE id=?', undef, sha256_hex($next), $account);
    $db->do('INSERT INTO devices VALUES (?,?,?,?,?)', undef, $device, $account, $name, sha256_hex($secret), time);
    return {account => $account, device => $device, token => $secret, recovery => $next};
  });
}
1;
