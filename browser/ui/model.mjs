export const uid = () => crypto.randomUUID().replaceAll('-', '');
export function safeURL(input) {
  let text = String(input).trim();
  if (!text) throw new Error('Enter an address');
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(text) && !text.includes(' ')) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { url = new URL('https://duckduckgo.com/?q=' + encodeURIComponent(text)); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web addresses can be opened');
  if (url.username || url.password) throw new Error('Addresses containing credentials are not allowed');
  return url.href;
}
export function createState() {
  return {version:1, records:[], cursor:0, pending:null};
}
export function editRecord(state, id, kind, payload) {
  let record = state.records.find(r => r.id === id);
  if (!record) { record = {id:id || uid(), revision:0, kind, payload:{}, dirty:true, deleted:false}; state.records.push(record); }
  record.payload = structuredClone(payload); record.kind = kind; record.dirty = true; record.deleted = false;
  return record;
}
export function deleteRecord(state, id) {
  const record = state.records.find(r => r.id === id);
  if (record) { record.deleted = true; record.dirty = true; }
}
export function recordsOf(state, kind) {
  return state.records.filter(r => !r.deleted && r.kind === kind);
}
export function mergeRemote(state, remote, value) {
  const local = state.records.find(r => r.id === remote.id);
  if (local && remote.revision <= local.revision) return;
  if (local?.dirty) {
    if (!local.deleted) {
      const copy = structuredClone(local);
      copy.id = uid(); copy.revision = 0;
      copy.payload.conflict = true;
      copy.payload.title = (copy.payload.title || copy.kind) + ' (conflict copy)';
      state.records.push(copy);
    }
  }
  const next = {id:remote.id, revision:remote.revision, deleted:!!remote.deleted, dirty:false,
    kind:value?.kind || local?.kind || 'unknown', payload:value?.payload || {}};
  if (local) Object.assign(local, next); else state.records.push(next);
}
