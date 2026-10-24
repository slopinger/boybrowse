// Records use AES-256-GCM with a fresh 96-bit nonce and authenticated record IDs.
// WebCrypto in Chromium is backed by BoringSSL.
const encoder = new TextEncoder();
export const toBase64 = bytes => {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
};
export const fromBase64 = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid key or ciphertext');
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
};
export const newKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
const importKey = value => crypto.subtle.importKey('raw', fromBase64(value), 'AES-GCM', false, ['encrypt','decrypt']);
export async function encrypt(key, id, record) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce, additionalData:encoder.encode('boybrowse/v1/' + id)},
    await importKey(key), encoder.encode(JSON.stringify(record)));
  const envelope = new Uint8Array(nonce.length + data.byteLength);
  envelope.set(nonce); envelope.set(new Uint8Array(data), 12);
  return toBase64(envelope);
}
export async function decrypt(key, id, ciphertext) {
  const data = fromBase64(ciphertext);
  const plaintext = await crypto.subtle.decrypt({name:'AES-GCM', iv:data.slice(0,12), additionalData:encoder.encode('boybrowse/v1/' + id)},
    await importKey(key), data.slice(12));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
