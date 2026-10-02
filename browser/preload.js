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
  nav: { go: invoke("nav:go"), back: invoke("nav:back"), forward: invoke("nav:forward"), reload: invoke("nav:reload"),
         home: invoke("nav:home"), zoom: invoke("nav:zoom") },
  ui: { panel: invoke("ui:panel"), overlay: invoke("ui:overlay"), theme: invoke("ui:theme") },
  settings: {
    get: invoke("settings:get"), setProfile: invoke("settings:setProfile"), setApp: invoke("settings:setApp"),
    resetProfile: invoke("settings:resetProfile"), pickFolder: invoke("settings:pickFolder"),
    pickModel: invoke("settings:pickModel"), clearData: invoke("settings:clearData"), onChange: listen("settings"),
  },
  browser: { isDefault: invoke("browser:isDefault"), makeDefault: invoke("browser:makeDefault") },
  app: { info: invoke("app:info"), relaunch: invoke("app:relaunch") },
  permission: { answer: invoke("permission:answer"), forget: invoke("permission:forget"),
                onAsk: listen("permission-ask") },
  profiles: { list: invoke("profiles:list"), create: invoke("profiles:create"), rename: invoke("profiles:rename"),
              open: invoke("profiles:open"), remove: invoke("profiles:remove"), onChange: listen("profiles"),
              googleSignIn: invoke("profiles:googleSignIn"), googleSignOut: invoke("profiles:googleSignOut"),
              refreshAccount: invoke("profiles:refreshAccount") },
  library: {
    bookmark: invoke("library:bookmark"), bookmarks: invoke("library:bookmarks"),
    removeBookmark: invoke("library:removeBookmark"), history: invoke("library:history"),
    clearHistory: invoke("library:clearHistory"), sites: invoke("library:sites"), setSite: invoke("library:setSite"),
  },
  downloads: { list: invoke("downloads:list"), open: invoke("downloads:open"), show: invoke("downloads:show"),
               cancel: invoke("downloads:cancel"), onChange: listen("downloads") },
  sessions: { list: invoke("sessions:list"), get: invoke("sessions:get"), create: invoke("sessions:create"),
              append: invoke("sessions:append"), rename: invoke("sessions:rename"), remove: invoke("sessions:remove"),
              clear: invoke("sessions:clear") },
  system: { check: invoke("system:check") },
  setup: { run: invoke("setup:run"), status: invoke("setup:status"), onProgress: listen("setup-progress") },
  model: { catalog: invoke("model:catalog"), info: invoke("model:info") },
  services: { get: invoke("services:get"), start: invoke("services:start"), restart: invoke("services:restart"),
              onChange: listen("services") },
  practice: { open: invoke("practice:open") },
  agent: { run: invoke("agent:run"), events: invoke("agent:events"), stop: invoke("agent:stop"),
           confirm: invoke("agent:confirm") },
  update: { check: invoke("update:check"), download: invoke("update:download"), install: invoke("update:install"),
            state: invoke("update:state"), onChange: listen("update") },
  openExternal: invoke("shell:open"),
  onCommand: listen("command"),
});
