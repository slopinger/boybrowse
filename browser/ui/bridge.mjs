// This page is shipped as a privileged Chromium WebUI, never a remote web app.
export function native(operation, data = {}) {
  if (!globalThis.chrome?.send) return Promise.reject(new Error('Open this page in Boybrowse to use browser controls'));
  return new Promise((resolve, reject) => {
    const id = 'boybrowse_' + crypto.randomUUID();
    pending.set(id, {resolve, reject});
    chrome.send('boybrowse', [id, operation, data]);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('Browser operation timed out')); }
    }, 15000);
  });
}
const pending = new Map();
globalThis.cr = globalThis.cr || {};
globalThis.cr.webUIResponse = (id, success, result) => {
  const callback = pending.get(id);
  if (!callback) return;
  pending.delete(id);
  success ? callback.resolve(result) : callback.reject(new Error(result));
};
