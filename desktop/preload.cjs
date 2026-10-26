/**
 * The only bridge between the window and the machine.
 *
 * The page never gets `node` and never sees a filesystem API: it can ask for a native dialog, ask
 * for the plan of a file, start a batch, and reveal a result in Finder. Everything else — reading
 * bytes, holding the token, writing the output — stays in the main process.
 *
 * CommonJS on purpose: a sandboxed preload is a CommonJS script, and this window keeps the sandbox
 * on.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dlss5', {
  status: () => ipcRenderer.invoke('app:status'),
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  register: (email, password) => ipcRenderer.invoke('auth:register', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  pickOutDir: () => ipcRenderer.invoke('dialog:outdir'),
  inspect: (files, options) => ipcRenderer.invoke('files:inspect', { files, options }),
  start: (files, options) => ipcRenderer.invoke('batch:start', { files, options }),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  openSite: () => ipcRenderer.invoke('shell:site'),
  /** A dropped File has no path in the renderer any more; this is the supported way to get one. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || '';
    }
  },
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('batch:event', listener);
    return () => ipcRenderer.removeListener('batch:event', listener);
  }
});
