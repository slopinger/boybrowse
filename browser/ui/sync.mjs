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
    Object.assign(this.secret, result, {name});
    this.state.cursor = 0; this.state.pending = null;
    for (const r of this.state.records) { r.revision = 0; r.dirty = true; }
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
    Object.assign(this.secret,result,{name});
    this.state.cursor = 0; this.state.pending = null;
    // Reset bases and let the conflict resolver preserve offline edits on recovery.
    for (const record of this.state.records) { record.revision = 0; record.dirty = true; }
    await this.saveSecret(this.secret); await this.save();
  }
  async run() {
    if (this.running) return this.running;
    this.running = this.exchange().finally(() => { this.running = null; });
    return this.running;
  }
  async sendPending() {
    const pending = this.state.pending;
    if (!pending) return true;
    try {
      const result = await this.request('records', {operation:pending.operation, records:pending.records});
      for (const written of result.records) {
        const record = this.state.records.find(r => r.id === written.id);
        if (record) {
          record.revision = written.revision;
          // Edits made while the request was in flight remain dirty.
          const sent = pending.snapshots[record.id];
          if (JSON.stringify(record.payload) === sent.payload && record.deleted === sent.deleted && record.kind === sent.kind) record.dirty = false;
        }
      }
      this.state.pending = null;
      await this.save();
      return true;
    } catch (error) {
      if (error.status === 409) { this.state.pending = null; await this.save(); return false; }
      throw error;
    }
  }
  async exchange() {
    if (!this.secret?.token) throw new Error('Connect a sync account first');
    await this.sendPending();
    // A write can race another device after the pull. Re-pull and preserve a
    // conflict copy before retrying; never report a rejected write as synced.
    for (let attempt = 0; attempt < 3; attempt++) {
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
      let offset = 0, conflicted = false;
      while (offset < dirty.length) {
        const snapshots = {}, records = [];
        let bytes = 128; // JSON envelope and operation ID.
        while (offset < dirty.length && records.length < 32) {
          const r = structuredClone(dirty[offset]);
          const record = {id:r.id,base:r.revision,deleted:r.deleted ? 1 : 0,
            ciphertext:await encrypt(this.secret.key,r.id,{kind:r.kind,payload:r.payload,deleted:r.deleted})};
          if (record.ciphertext.length > 349528) throw new Error('A sync item is too large. Shorten the note or workspace before retrying.');
          const size = JSON.stringify(record).length + 1;
          // Leave headroom below the server's 5 MiB request limit.
          if (bytes + size > 4 * 1024 * 1024) break;
          records.push(record); bytes += size; offset++;
          snapshots[r.id] = {payload:JSON.stringify(r.payload), deleted:r.deleted, kind:r.kind};
        }
        this.state.pending = {operation:uid(),records,snapshots};
        await this.save(); // Durable outbox exists before the network write.
        if (!await this.sendPending()) { conflicted = true; break; }
      }
      if (!conflicted && !this.state.records.some(r => r.dirty)) return;
    }
    throw new Error('Other devices are changing these items. Your edits are saved; sync again shortly.');
  }
}
