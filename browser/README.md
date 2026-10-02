# Jev Browser

A Chromium-based desktop browser (Electron 44) with the Jev agent built in. Type a goal in the side panel, and the agent
works on the tab you are viewing, with a visible cursor. It asks before anything that buys, sends or deletes.

```bash
cd browser
npm install
npm start          # development
npm run dist       # macOS installer: dist/Jev Browser-<version>-arm64.dmg
npm run dist:linux # Linux Mint / Ubuntu / Debian: .deb and AppImage, x64 and arm64
```

A Windows NSIS installer is configured (`electron-builder --win`) but has not been built or tested.

### Linux Mint (and Ubuntu, Debian)

```bash
sudo apt install ./jev-browser_0.1.0_amd64.deb   # adds Jev Browser to the menu
sudo apt install libgomp1                        # OpenMP runtime that llama.cpp builds need
curl -LsSf https://astral.sh/uv/install.sh | sh  # Python runtime for the agent
```

Then install a [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases) and put `llama-server` on your
`PATH`: the Vulkan or CUDA build for a GPU, or the plain Ubuntu build for the CPU. You can also set
`JEV_LLAMA_SERVER=/path/to/llama-server`. The AppImage needs no installation: `chmod +x` it and run it.

## Requirements

- [uv](https://docs.astral.sh/uv/), which runs the bundled Python agent.
- For the local agent: `llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp) (`brew install llama.cpp`
  on macOS) and about 1.5 GB of free memory. The 1.1 GB model is downloaded during onboarding if it is not already cached.

Onboarding checks both and explains how to install anything that is missing.

## What it does

**First run.** Welcome, choice of where the agent runs, a check of this computer (memory, disk, uv, llama.cpp,
model), a model download with progress, resume and a SHA-256 check, a summary of what the agent may do, and a guided
first task on a built-in practice shop.

**Browsing.** Tabs, private tabs (in-memory session, no history, cookies forgotten when the last one closes), back,
forward, reload, and an address bar that loads addresses and searches anything else. You can choose the search
engine. Bookmarks (☆ or ⌘D), history with search and clear, and downloads (open, show in folder, cancel). Shortcuts
are in the app menu, so they also work while focus is inside a page.

**Agent.**
- The side panel streams every step and has a Stop button.
- The first time the agent runs on a site, it asks: always, only this time, or never. Choices are listed in
  Settings → Sites.
- Before a click that looks like buying, paying, ordering, sending, deleting, transferring, subscribing or confirming,
  the run pauses for Allow or Don't allow. It is denied after two minutes or on Stop.
- A visible cursor, outline and typing show each action.

**GPU or CPU.** The local model uses whatever GPU the installed llama.cpp supports: Metal on Macs, CUDA on NVIDIA,
ROCm on AMD, Vulkan on most other GPUs. If the GPU cannot start it, the model falls back to the CPU automatically.
Settings → Accelerator can force GPU or CPU. CPU mode keeps a single copy of the weights and small batches, so it fits
the same 2 GB limit, but it is slower. Measured on an M4:

| Accelerator | Memory | One decision readout (~500 tokens) | Hotel fixture end to end |
| --- | --- | --- | --- |
| GPU (Metal) | 1,436 MB | 0.4 s | 5.3 s |
| CPU (10 threads) | 1,467 MB | 1.9 s | 18.8 s |

**Settings.** Search engine, home page, agent mode (local or hosted), accelerator, memory limit (2 or 2.5 GB), cursor,
risky-action confirmation, autostart, sites and history.

## Architecture

| File | Job |
| --- | --- |
| `main.js` | Window, tabs (one sandboxed view each), private sessions, downloads, practice server, menu, IPC |
| `preload.js` | The only bridge from the browser UI to the main process |
| `services.js` | Starts and supervises the model server and the agent server on fresh loopback ports |
| `model.js` | Finds or downloads the model (resume, redirect, SHA-256 check) |
| `system.js` | The onboarding system check |
| `store.js` | Bookmarks, history and per-site agent permissions as atomic JSON files |
| `ui/` | Tab strip, toolbar, agent panel, Library, Settings and onboarding |
| `practice/` | The practice shop used for the first guided task |

The agent is the Python package in the repository root (`jev_ultrafast`), bundled into the app's resources.

- `jev-local` runs GUI-Owl-1.5-2B under the memory lock.
- `jev-chat` runs the agent loop. It attaches to the current tab through Jev Browser's loopback DevTools port over a
  direct connection (`JEV_CDP_WS`). It accepts requests only with a per-launch token.
- Both services exit by themselves if the browser process goes away, even after a crash or force-quit.

Tabs have no Node access, run sandboxed and get no permissions (camera, location and so on). Pop-ups open as tabs.
Page and model text in the UI is always plain text, never HTML.

## Tests

```bash
npm test           # offline: model download/resume/checksum, library stores, system check
npm run check      # syntax
```

The repository's Python tests cover the agent server: tokens, one run at a time, risky-action approval, stopping
before execution, and sidecar shutdown. A scripted end-to-end run drives this app through its own UI over the loopback
DevTools port. It covers onboarding, the system check, the guided task with deny and allow, bookmarks, history, a
private tab, site permissions, a download and settings. It passed 19/19 in development and in the packaged macOS app.

## Known limits

- The installer is not code-signed or notarized, so macOS asks for confirmation on first open. There is no
  auto-update.
- The DevTools port (9444) listens on loopback only, but any program on this computer can use it while the browser
  runs.
- Agent accuracy is that of the 2B local model. It handles simple multi-step pages and fails on complex ones such as
  Google Flights.
- There is no extension store, no sync, and no DRM video.
