"""Offline checks for the local model launcher's GPU/CPU choice. No llama.cpp or model needed."""

import stat
import sys

import pytest

from jev_ultrafast import local

LIST = """Available devices:
  CUDA0: NVIDIA GeForce RTX 4060 (8188 MiB, 7900 MiB free)
  Vulkan0: AMD Radeon 780M (4096 MiB, 4000 MiB free)
  BLAS: OpenBLAS (0 MiB, 0 MiB free)
  CPU: AMD Ryzen 7 (31000 MiB, 20000 MiB free)
"""


def fake_llama(tmp_path, monkeypatch, listing):
    script = tmp_path / "llama-server"
    script.write_text(f"#!{sys.executable}\nprint({listing!r})\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("JEV_LLAMA_SERVER", str(script))


def test_gpus_lists_only_offload_devices(tmp_path, monkeypatch):
    fake_llama(tmp_path, monkeypatch, LIST)
    assert local.gpus() == ["NVIDIA GeForce RTX 4060 (CUDA0)", "AMD Radeon 780M (Vulkan0)"]
    fake_llama(tmp_path, monkeypatch, "Available devices:\n  CPU: Intel Core i5 (16000 MiB, 9000 MiB free)\n")
    assert local.gpus() == []


def test_cpu_mode_never_offloads_and_keeps_one_weight_copy():
    cpu = local.DEVICE_FLAGS["cpu"]
    assert cpu[cpu.index("--device") + 1] == "none" and cpu[cpu.index("--n-gpu-layers") + 1] == "0"
    assert "--no-repack" in cpu


@pytest.mark.parametrize("found, failing, expected", [
    (["GPU (CUDA0)"], set(), ["gpu"]),            # GPU works
    (["GPU (CUDA0)"], {"gpu"}, ["gpu", "cpu"]),   # GPU fails to start: fall back to the CPU
    ([], set(), ["cpu"]),                         # no GPU backend: straight to the CPU
])
def test_auto_tries_the_gpu_then_falls_back_to_the_cpu(monkeypatch, tmp_path, found, failing, expected):
    tried = []

    class Server:
        pid = 1

        def poll(self):
            return 0  # exits right away so main() returns after the start-up report

        def terminate(self):
            pass

    def launch(device, *_):
        tried.append(device)
        if device in failing:
            raise local.StartFailed("no")
        return Server()

    monkeypatch.setattr(local, "gpus", lambda: found)
    monkeypatch.setattr(local, "launch", launch)
    monkeypatch.setattr(local, "port_free", lambda port: True)
    monkeypatch.setattr(local, "footprint_mb", lambda pid: 100)
    monkeypatch.setattr(sys, "argv", ["jev-local", "--model", str(tmp_path / "m.gguf"), "--device", "auto"])
    (tmp_path / "m.gguf").write_bytes(b"x")
    with pytest.raises(SystemExit):
        local.main()
    assert tried == expected
