"""One local llama-server for decisions and field text, held under a fixed memory budget."""

import argparse
import ctypes
import os
import platform
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

BUDGET_MB = 2048
AGENT_RESERVE_MB = 256  # the agent's own Python process; the browser is not counted
# Every setting that can grow memory is pinned: one slot, a fixed 8-bit KV cache, no host prompt cache, no auto-fit.
FLAGS = [
    "--ctx-size", "4096", "--parallel", "1", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0",
    "--cache-ram", "0", "--fit", "off", "--no-mmproj", "--jinja",
]
# GPU: offload every layer (Metal, CUDA, ROCm/HIP or Vulkan, whichever this llama.cpp build has). CPU: offload nothing.
# CPU mode keeps one copy of the weights (no repacking) and small batch buffers, so it fits the same budget.
DEVICE_FLAGS = {
    "gpu": ["--n-gpu-layers", "all"],
    "cpu": ["--device", "none", "--n-gpu-layers", "0", "--no-repack", "--batch-size", "512", "--ubatch-size", "256"],
}
NOT_GPU = ("CPU", "BLAS")  # llama.cpp lists these host backends among its devices


class StartFailed(RuntimeError):
    """llama-server did not come up on this device."""


def llama_server():
    return os.environ.get("JEV_LLAMA_SERVER") or "llama-server"


def gpus():
    """GPU devices this llama.cpp build can use, as listed by `llama-server --list-devices`."""
    try:
        out = subprocess.run([llama_server(), "--list-devices"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return []
    found = re.findall(r"^\s+(\S+?):\s+(.+?)\s+\(", out.stdout + out.stderr, re.M)
    return [f"{desc} ({name})" for name, desc in found if not name.upper().startswith(NOT_GPU)]
WARMUP = "Visible page text. " * 600  # about the longest prompt the agent sends, to reach the steady-state peak


def footprint_mb(pid):
    """Resident memory, counted conservatively. RSS includes the memory-mapped weights; on macOS the physical
    footprint includes Metal buffers that RSS leaves out. The larger of the two is reported."""
    if platform.system() == "Darwin":
        out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
        found = re.search(r"phys_footprint:\s+([\d.]+)\s*([KMG]B)", out)
        rss = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if found and rss:
            return max(float(found[1]) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[found[2]], int(rss) / 1024)
    status = Path(f"/proc/{pid}/status")
    if status.exists():
        found = re.search(r"VmRSS:\s+(\d+) kB", status.read_text())
        return int(found[1]) / 1024 if found else None
    return None


def parent_gone():
    """True when the app that started this process (JEV_PARENT_PID) has exited, so sidecars never outlive it."""
    pid = int(os.environ.get("JEV_PARENT_PID") or 0)
    if not pid:
        return False
    if os.name == "nt":  # os.kill(pid, 0) terminates processes on Windows; ask the process API instead
        handle = ctypes.windll.kernel32.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return True
        alive = ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
        ctypes.windll.kernel32.CloseHandle(handle)
        return not alive
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False


def port_free(port):
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) != 0


def launch(device, source, port, key):
    """Start llama-server on one device and warm it up. Raises StartFailed if it cannot run there."""
    server = subprocess.Popen([llama_server(), *source, *FLAGS, *DEVICE_FLAGS[device], "--host", "127.0.0.1",
                               "--port", str(port), "--api-key", key])
    base = f"http://127.0.0.1:{port}"
    try:
        while True:
            if server.poll() is not None:
                raise StartFailed(f"llama-server exited during startup on the {device.upper()}.")
            try:
                if httpx.get(base + "/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(1)
        warm = httpx.post(base + "/completion", headers={"Authorization": f"Bearer {key}"}, timeout=300,
                          json={"prompt": WARMUP, "n_predict": 4, "n_probs": 100, "cache_prompt": False})
        if warm.status_code != 200 or server.poll() is not None:
            raise StartFailed(f"Warm-up failed on the {device.upper()} (HTTP {warm.status_code}).")
        return server
    except BaseException:
        if server.poll() is None:
            server.terminate()
            server.wait(10)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hf", default="mradermacher/GUI-Owl-1.5-2B-Instruct-GGUF:Q4_K_M", help="repo:quant")
    parser.add_argument("--model", help="local .gguf path instead of --hf")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--budget-mb", type=int, default=BUDGET_MB)
    parser.add_argument("--device", choices=["auto", "gpu", "cpu"], default=os.environ.get("JEV_DEVICE", "auto"),
                        help="auto: GPU when available, otherwise or on failure the CPU")
    args = parser.parse_args()
    limit = args.budget_mb - AGENT_RESERVE_MB
    if args.model and Path(args.model).stat().st_size / 2**20 > limit * 0.8:
        sys.exit(f"{args.model} leaves too little of the {args.budget_mb} MB budget for its cache.")
    # A normal quit sends SIGTERM; exit through `finally` so llama-server is stopped too, never orphaned.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit("Stopped."))
    if not port_free(args.port):
        sys.exit(f"Port {args.port} is already in use; another model server may still be running.")
    key = os.environ.get("DECISION_MODEL_API_KEY") or os.urandom(12).hex()
    source = ["--model", args.model] if args.model else ["--hf-repo", args.hf]
    found = gpus()
    order = {"gpu": ["gpu"], "cpu": ["cpu"], "auto": ["gpu", "cpu"] if found else ["cpu"]}[args.device]
    server, device = None, None
    for attempt in order:
        try:
            server, device = launch(attempt, source, args.port, key), attempt
            break
        except StartFailed as error:
            print(f"{error}{' Trying the CPU.' if attempt != order[-1] else ''}", flush=True)
    if server is None:
        sys.exit("llama-server could not start on any device.")
    base = f"http://127.0.0.1:{args.port}"
    try:
        print(f"Accelerator: {'GPU, ' + ', '.join(found) if device == 'gpu' else f'CPU, {os.cpu_count()} threads'}",
              flush=True)
        used = footprint_mb(server.pid)
        if used is None:
            print("Memory could not be measured on this platform; the budget is not enforced.", flush=True)
        elif used > limit:
            sys.exit(f"Warm footprint {used:.0f} MB exceeds the {limit} MB model budget; stopped.")
        else:
            print(f"Warm footprint {used:.0f} MB of {limit} MB (budget {args.budget_mb} MB with the agent).")
        print(f"\nDECISION_MODEL_BASE_URL={base}\nDECISION_MODEL_API_KEY={key}\n"
              f"TEXT_MODEL_BASE_URL={base}/v1\nTEXT_MODEL_API_KEY={key}\nTEXT_MODEL_REASONING=none\n", flush=True)
        while server.poll() is None:
            if parent_gone():
                sys.exit("The app that started this model server exited; stopping.")
            used = footprint_mb(server.pid)
            if used is not None and used > limit:
                sys.exit(f"Footprint {used:.0f} MB exceeded the {limit} MB model budget; stopped.")
            time.sleep(1)
        sys.exit("llama-server exited.")
    finally:
        if server.poll() is None:
            server.terminate()
            server.wait(10)


if __name__ == "__main__":
    main()
