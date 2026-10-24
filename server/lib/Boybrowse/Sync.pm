package Boybrowse::Sync;
use Mojo::Base 'Mojolicious', -signatures;
use Boybrowse::Store;
use Mojo::JSON;
has store => sub { Boybrowse::Store->new($ENV{BOYBROWSE_DB} // 'boybrowse.sqlite3') };

sub startup ($self) {
  $self->max_request_size(5 * 1024 * 1024);
  $self->log->level('warn');
  $self->hook(before_dispatch => sub ($c) {
    $c->res->headers->header('Cache-Control' => 'no-store');
    $c->res->headers->header('X-Content-Type-Options' => 'nosniff');
    $c->res->headers->header('Content-Security-Policy' => "default-src 'none'; frame-ancestors 'none'");
    my $origin = $c->req->headers->origin // '';
    if ($origin eq 'chrome://boybrowse') {
      $c->res->headers->header('Access-Control-Allow-Origin' => $origin);
      $c->res->headers->header('Vary' => 'Origin');
      $c->res->headers->header('Access-Control-Allow-Headers' => 'Authorization, Content-Type');
      $c->res->headers->header('Access-Control-Allow-Methods' => 'GET, POST, DELETE, OPTIONS');
    }
    if ($origin ne '' && $origin ne 'chrome://boybrowse') {
      return $c->render(status => 403, json => {error => 'origin'});
    }
    return $c->render(status => 204, text => '') if $c->req->method eq 'OPTIONS';
  });
  my $r = $self->routes;
  $r->get('/healthz')->to(cb => sub ($c) {
    $c->app->store->db->selectrow_array('SELECT 1');
    $c->render(json => {status => 'ok', protocol => 1});
  });
  my $public = $r->under('/v1')->to(cb => sub ($c) {
    # Use the socket peer, never a caller-supplied forwarding header.
    return $c->render(status => 429, json => {error => 'rate_limit'}) && undef
      unless $c->app->store->rate('public:' . $c->tx->remote_address, 30);
    return 1;
  });
  $public->post('/enroll')->to(cb => sub ($c) {
    my $body = $c->req->json;
    return $c->render(status => 400, json => {error => 'invalid'}) unless valid_name($body) && valid_token($body->{invitation});
    my $result = $c->app->store->enroll($body->{invitation}, $body->{name});
    return $c->render(status => 401, json => {error => 'invitation'}) unless $result;
    $c->render(status => 201, json => $result);
  });
  $public->post('/recover')->to(cb => sub ($c) {
    my $body = $c->req->json;
    return $c->render(status => 400, json => {error => 'invalid'}) unless valid_name($body) && valid_id($body->{account}) && valid_token($body->{recovery});
    my $result = $c->app->store->recover(@$body{qw(account recovery name)});
    return $c->render(status => 401, json => {error => 'recovery'}) unless $result;
    $c->render(json => $result);
  });
  my $auth = $r->under('/v1')->to(cb => sub ($c) {
    my ($token) = ($c->req->headers->authorization // '') =~ /^Bearer ([A-Za-z0-9_-]{43})$/;
    my $device = $token ? $c->app->store->authorize($token) : undef;
    unless ($device) {
      my $allowed = $c->app->store->rate('auth:' . $c->tx->remote_address, 30);
      $c->render(status => $allowed ? 401 : 429, json => {error => $allowed ? 'unauthorized' : 'rate_limit'});
      return undef;
    }
    unless ($c->app->store->rate('device:' . $device->{id}, 240)) {
      $c->render(status => 429, json => {error => 'rate_limit'}); return undef;
    }
    $c->stash(device => $device);
    return 1;
  });
  $auth->get('/records')->to(cb => sub ($c) {
    my $cursor = $c->param('cursor') // '0';
    return $c->render(status => 400, json => {error => 'cursor'}) unless $cursor =~ /^\d{1,15}$/;
    $c->render(json => $c->app->store->pull($c->stash('device')->{account}, 0 + $cursor));
  });
  $auth->post('/records')->to(cb => sub ($c) {
    my $body = $c->req->json;
    return $c->render(status => 400, json => {error => 'batch'}) unless ref($body) eq 'HASH' && valid_id($body->{operation}) && ref($body->{records}) eq 'ARRAY' && @{$body->{records}} >= 1 && @{$body->{records}} <= 32;
    my %seen;
    for my $record (@{$body->{records}}) {
      return $c->render(status => 400, json => {error => 'record'}) unless ref($record) eq 'HASH' &&
        valid_id($record->{id}) && !$seen{$record->{id}}++ &&
        defined($record->{base}) && !ref($record->{base}) && $record->{base} =~ /^\d{1,15}$/ &&
        defined($record->{deleted}) && !ref($record->{deleted}) && $record->{deleted} =~ /^[01]$/ &&
        defined($record->{ciphertext}) && !ref($record->{ciphertext}) &&
        length($record->{ciphertext}) <= 349528 &&
        $record->{ciphertext} =~ /^[A-Za-z0-9_-]{38,}$/;
    }
    my $result = $c->app->store->push($c->stash('device')->{account}, @$body{qw(operation records)});
    $c->render(status => $result->[0], json => $result->[1]);
  });
  $auth->get('/devices')->to(cb => sub ($c) {
    $c->render(json => {devices => $c->app->store->db->selectall_arrayref('SELECT id,name,created FROM devices WHERE account=? ORDER BY created,id', {Slice => {}}, $c->stash('device')->{account})});
  });
  $auth->post('/pair')->to(cb => sub ($c) {
    $c->render(status => 201, json => {invitation => $c->app->store->invite($c->stash('device')->{account}, 600), expires_in => 600});
  });
  $auth->delete('/devices/:id')->to(cb => sub ($c) {
    $c->app->store->db->do('DELETE FROM devices WHERE account=? AND id=?', undef, $c->stash('device')->{account}, $c->param('id'));
    $c->render(status => 204, text => '');
  });
  $auth->delete('/account')->to(cb => sub ($c) {
    my $body = $c->req->json;
    return $c->render(status => 400, json => {error => 'confirmation'}) unless ref($body) eq 'HASH' && ($body->{confirm} // '') eq 'delete my account';
    $c->app->store->db->do('DELETE FROM accounts WHERE id=?', undef, $c->stash('device')->{account});
    $c->render(status => 204, text => '');
  });
}
sub valid_id { defined($_[0]) && !ref($_[0]) && $_[0] =~ /^[a-f0-9]{32}$/ }
sub valid_token { defined($_[0]) && !ref($_[0]) && $_[0] =~ /^[A-Za-z0-9_-]{43}$/ }
sub valid_name {
  ref($_[0]) eq 'HASH' && defined($_[0]{name}) && !ref($_[0]{name}) && length($_[0]{name}) >= 1 && length($_[0]{name}) <= 80 && $_[0]{name} !~ /[\x00-\x1f]/
}
1;
