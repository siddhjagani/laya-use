// The only bridge between the browser UI and the main process. Web pages in tabs never get this.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("jev", {
  tabs: { create: invoke("tabs:new"), close: invoke("tabs:close"), activate: invoke("tabs:activate"),
          onChange: listen("tabs") },
  nav: { go: invoke("nav:go"), back: invoke("nav:back"), forward: invoke("nav:forward"), reload: invoke("nav:reload") },
  ui: { panel: invoke("ui:panel"), overlay: invoke("ui:overlay") },
  settings: { get: invoke("settings:get"), set: invoke("settings:set"), onChange: listen("settings") },
  library: {
    bookmark: invoke("library:bookmark"), bookmarks: invoke("library:bookmarks"),
    removeBookmark: invoke("library:removeBookmark"), history: invoke("library:history"),
    clearHistory: invoke("library:clearHistory"), sites: invoke("library:sites"), setSite: invoke("library:setSite"),
  },
  downloads: { list: invoke("downloads:list"), open: invoke("downloads:open"), show: invoke("downloads:show"),
               cancel: invoke("downloads:cancel"), onChange: listen("downloads") },
  system: { check: invoke("system:check") },
  model: { info: invoke("model:info"), download: invoke("model:download"), cancel: invoke("model:cancel"),
           onProgress: listen("model-progress") },
  services: { get: invoke("services:get"), start: invoke("services:start"), onChange: listen("services") },
  practice: { open: invoke("practice:open") },
  agent: { run: invoke("agent:run"), events: invoke("agent:events"), stop: invoke("agent:stop"),
           confirm: invoke("agent:confirm") },
  openExternal: invoke("shell:open"),
  onCommand: listen("command"),
});
