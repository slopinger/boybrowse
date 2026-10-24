import {uid, mergeRemote} from './model.mjs';
import {encrypt, decrypt, newKey} from './crypto.mjs';

export class SyncClient {
  constructor({state, save, secret, saveSecret, fetcher = fetch}) {
    Object.assign(this, {state, save, secret, saveSecret, fetcher});
  }
  endpoint(server) {
    const url = new URL(server);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Sync requires HTTPS');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a server origin without a path');
    return url.origin;
  }
  async request(path, data, method = data === undefined ? 'GET' : 'POST', anonymous = false) {
    const response = await this.fetcher(this.secret.server + '/v1/' + path, {
      method, redirect:'error', credentials:'omit', referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json', ...(!anonymous && this.secret.token ? {Authorization:'Bearer ' + this.secret.token} : {})},
      ...(data !== undefined ? {body:JSON.stringify(data)} : {}),
      signal:AbortSignal.timeout(20000)
    });
    if (response.status === 204) return {};
    const body = await response.json();
    if (!response.ok) { const e = new Error(body.error || 'Sync request failed'); e.status = response.status; throw e; }
    return body;
  }
  async enroll(server, invitation, name, pairingKey) {
    this.secret = {server:this.endpoint(server), key:pairingKey || newKey()};
    // Verify OS-protected storage before creating a remote account.
    await this.saveSecret(this.secret);
    const result = await this.request('enroll', {invitation,name}, 'POST', true);
    Object.assign(this.secret, result);
    this.state.cursor = 0; this.state.pending = null;
    for (const r of this.state.records) { r.id = uid(); r.revision = 0; r.dirty = true; }
    await this.saveSecret(this.secret); await this.save();
    return result;
  }
  recoveryBundle() {
    if (!this.secret?.recovery) throw new Error('Only the enrolling or recovered device can export a recovery kit');
    return {version:1, server:this.secret.server, account:this.secret.account, key:this.secret.key, recovery:this.secret.recovery};
  }
  async pairingBundle() {
    const pair = await this.request('pair', {});
    return {version:1, server:this.secret.server, invitation:pair.invitation, key:this.secret.key};
  }
  async recover(bundle, name) {
    if (bundle.version !== 1 || typeof bundle.key !== 'string') throw new Error('Invalid recovery kit');
    this.secret = {server:this.endpoint(bundle.server), key:bundle.key};
    const result = await this.request('recover', {account:bundle.account, recovery:bundle.recovery, name}, 'POST', true);
    Object.assign(this.secret,result);
    this.state.cursor = 0; this.state.pending = null;
    // Preserve this installation's data as new records rather than overwriting remote records.
    for (const record of this.state.records) { record.id = uid(); record.revision = 0; record.dirty = true; }
    await this.saveSecret(this.secret); await this.save();
  }
  async run() {
    if (this.running) return this.running;
    this.running = this.exchange().finally(() => { this.running = null; });
    return this.running;
  }
  async sendPending() {
    const pending = this.state.pending;
    if (!pending) return;
    try {
      const result = await this.request('records', {operation:pending.operation, records:pending.records});
      for (const written of result.records) {
        const record = this.state.records.find(r => r.id === written.id);
        if (record) {
          record.revision = written.revision;
          // Edits made while the request was in flight remain dirty.
          const sent = pending.snapshots[record.id];
          if (JSON.stringify(record.payload) === sent.payload && record.deleted === sent.deleted) record.dirty = false;
        }
      }
      this.state.pending = null;
      await this.save();
    } catch (error) {
      if (error.status === 409) { this.state.pending = null; await this.save(); }
      else throw error;
    }
  }
  async exchange() {
    if (!this.secret?.token) throw new Error('Connect a sync account first');
    await this.sendPending();
    let more = true;
    while (more) {
      const result = await this.request('records?cursor=' + this.state.cursor);
      // Authenticate the entire page before changing the cursor or local records.
      const decoded = await Promise.all(result.records.map(async r => {
        const value = await decrypt(this.secret.key, r.id, r.ciphertext);
        if (value.deleted !== !!r.deleted) throw new Error('Sync record authentication failed');
        return [r,value];
      }));
      for (const [remote,value] of decoded) mergeRemote(this.state, remote, value);
      this.state.cursor = result.cursor; more = !!result.more;
      await this.save();
    }
    const dirty = this.state.records.filter(r => r.dirty);
    for (let offset = 0; offset < dirty.length; offset += 32) {
      const batch = dirty.slice(offset, offset + 32);
      const snapshots = {};
      const records = await Promise.all(batch.map(async r => {
        snapshots[r.id] = {payload:JSON.stringify(r.payload), deleted:r.deleted};
        return {id:r.id,base:r.revision,deleted:r.deleted ? 1 : 0,
          ciphertext:await encrypt(this.secret.key,r.id,{kind:r.kind,payload:r.payload,deleted:r.deleted})};
      }));
      this.state.pending = {operation:uid(),records,snapshots};
      await this.save(); // Durable outbox exists before the network write.
      await this.sendPending();
    }
  }
}
