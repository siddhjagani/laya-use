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

## Setup is automatic

Nothing has to be installed by hand. On first launch, onboarding checks the computer and **Set up automatically**
downloads into Jev Browser's own data folder:

- **uv** (Python runtime) for this operating system and processor.
- **llama.cpp**: the newest official build for this computer. On Linux that is the Vulkan GPU build when a Vulkan
  driver is present, otherwise the CPU build. On macOS it is the Metal build.
- **libgomp** (Linux only, when missing): unpacked from the distribution's own package with `apt-get download`, so no
  password is needed. Only if that fails does it ask through the desktop's password prompt.
- **The model** (1.1 GB), checked against its SHA-256 before use.
- **The agent's Python packages**, prepared once so the first chat does not wait.

Working copies of uv or llama.cpp that are already installed are reused. Settings → Model → Repair runs the same steps
again.

## What it does

**Profiles.** Each profile has its own window, cookies, history, bookmarks, settings and agent chats. You can sign in
to Google in a profile (Settings → You and Google, or the profile menu). Its name, email and photo then show on the
profile, and Gmail, YouTube, Drive and other Google sites stay signed in. Jev Browser sends a standard Chrome user
agent, so Google's sign-in page accepts it. Chrome Sync is only available in Google Chrome.

**Agent chats.** The ✎ button starts a new chat. The ⟲ button lists past chats with search, and any chat can be reopened
and continued. Optional thinking: Settings → Agent → "Think before each step" generates a short reasoning note
before each action. "Show thinking in the chat" shows it as a collapsible block. Thinking models return it as their
reasoning.

**Settings** follow Chrome's layout, with search: You and Google, Agent, Model, Appearance, Search engine, On startup,
Privacy and security, Site settings, Downloads, Languages, Default browser, System, Reset settings, About.

- **Privacy and security:** clear data, Do Not Track and GPC, third-party cookie blocking, HTTPS-only, clear on exit.
- **Site settings:** a default (ask, allow or block) and per-site choices for location, camera and microphone,
  notifications and more. Sites ask through a prompt.
- **Model:** setup status, the model catalog or your own GGUF file, accelerator (automatic, GPU or CPU), memory limit,
  context window and CPU threads.

**Updates.** Settings → About checks this project's GitHub Releases, downloads the installer for this computer and
verifies it against the release's `SHA256SUMS.txt`. Then it installs: an AppImage replaces itself, a `.deb` installs
through the password prompt, and a `.dmg` opens. It also checks automatically, which you can turn off.

## Models

| Model | Size | Used for | Tested here |
| --- | --- | --- | --- |
| GUI-Owl-1.5-2B-Instruct Q4_K_M (default) | 1.1 GB | Agent decisions, field text, goal values, thinking | Practice shop, hotel fixture and Wikipedia pass; Google Flights fails |
| GUI-Owl-1.5-2B-Instruct Q5_K_M / Q3_K_M | larger / smaller | Same | Not benchmarked |
| Qwen3.5-2B Q4_K_M | 1.3 GB | Same; has a thinking mode | Lower than GUI-Owl on browser tasks |
| Qwen3.5-0.8B Q8_0 | 0.8 GB | Same; has a thinking mode | Fails most browser tasks |
| Hosted Jev (TypeSafe) | none | Decisions, when "Hosted" is chosen | The project's original 7-second Flights run |

One model does every job through one `llama-server`, under a 2 GB memory limit.

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
