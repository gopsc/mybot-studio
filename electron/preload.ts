import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { StderrEvent, StudioApi } from "../shared/types.js";

const api: StudioApi = {
  platform: process.platform,
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  currentWorkspace: () => ipcRenderer.invoke("workspace:current"),
  refreshWorkspace: () => ipcRenderer.invoke("workspace:refresh"),
  readFile: (path) => ipcRenderer.invoke("file:read", path),
  writeFile: (path, content) => ipcRenderer.invoke("file:write", path, content),
  createFile: (path, content) => ipcRenderer.invoke("file:create", path, content),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (settings) => ipcRenderer.invoke("settings:set", settings),
  resolvePython: () => ipcRenderer.invoke("python:resolve"),
  run: (id, request) => ipcRenderer.invoke("pymybot:run", id, request),
  cancel: (id) => ipcRenderer.invoke("pymybot:cancel", id),
  onStderr: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: StderrEvent) => listener(payload);
    ipcRenderer.on("pymybot:stderr", wrapped);
    return () => ipcRenderer.removeListener("pymybot:stderr", wrapped);
  },
};

contextBridge.exposeInMainWorld("studio", api);
