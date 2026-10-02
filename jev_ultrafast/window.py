"""A visible browser window with its own profile, for headed runs. The user's own browser profile is never used."""

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

EXTENSION = Path(__file__).resolve().parent.parent / "extension"  # the chat side panel, loaded unpacked
CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome", "chromium", "chromium-browser", "brave-browser",
]


def find_browser():
    for candidate in CANDIDATES:
        path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if path and os.path.exists(path):
            return path
    sys.exit("No Chrome, Chromium or Brave found.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9333)
    parser.add_argument("--profile", default=str(Path.home() / ".jev-ultrafast" / "browser-profile"))
    args = parser.parse_args()
    Path(args.profile).mkdir(parents=True, exist_ok=True)
    browser = subprocess.Popen([
        find_browser(), f"--remote-debugging-port={args.port}", "--remote-debugging-address=127.0.0.1",
        f"--user-data-dir={args.profile}", "--window-size=1140,900", "--no-first-run", "--no-default-browser-check",
        f"--load-extension={EXTENSION}", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                ws = httpx.get(f"http://127.0.0.1:{args.port}/json/version", timeout=1).json()["webSocketDebuggerUrl"]
                break
            except (httpx.HTTPError, KeyError, ValueError):
                time.sleep(0.5)
        else:
            sys.exit("The browser did not open its debugging port.")
        print(f"\nBU_CDP_WS={ws}\nJEV_SHOW=1\n\nKeep this running; close the window or press Ctrl+C.", flush=True)
        browser.wait()
    finally:
        if browser.poll() is None:
            browser.terminate()


if __name__ == "__main__":
    main()
