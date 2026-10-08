"""The WARP tunnel of chords-fetch (app.warp): wireproxy's config, waiting for warp=on, reconnecting, failing loud."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.warp import Warp, WarpError

TRACE_ON = "fl=1f1\nh=www.cloudflare.com\nip=2a09:bac1::1\ncolo=FRA\nloc=DE\nwarp=on\n"
TRACE_OFF = TRACE_ON.replace("warp=on", "warp=off")


class FakeProc:
    def __init__(self, args: list[str], exit_code: int | None = None) -> None:
        self.args, self.returncode, self.terminated = args, exit_code, False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated, self.returncode = True, -15

    def wait(self, timeout: float | None = None) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.returncode = -9


class Harness:
    def __init__(self, tmp_path: Path, traces: list[Any], exit_code: int | None = None) -> None:
        self.profile = tmp_path / "wgcf-profile.conf"
        self.profile.write_text("[Interface]\nPrivateKey = secret\n")
        self.traces, self.exit_code = list(traces), exit_code
        self.procs: list[FakeProc] = []
        self.now = 0.0
        self.warp = Warp(self.profile, trace=self.trace, popen=self.popen, sleep=self.sleep, clock=lambda: self.now,
                         work_dir=tmp_path / "warp", ready_timeout_s=5)

    def popen(self, args: list[str], **kw: Any) -> FakeProc:
        proc = FakeProc(args, self.exit_code)
        self.procs.append(proc)
        return proc

    def trace(self, proxy: str) -> str:
        assert proxy == "socks5h://127.0.0.1:40000"
        item = self.traces.pop(0) if self.traces else TRACE_OFF
        if isinstance(item, Exception):
            raise item
        return item

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_start_runs_wireproxy_on_the_profile_and_waits_for_warp_on(tmp_path: Path) -> None:
    h = Harness(tmp_path, [ConnectionError("not yet"), TRACE_OFF, TRACE_ON])
    h.warp.start()
    assert h.warp.ready and h.warp.sessions == 1 and h.warp.proxy == "socks5h://127.0.0.1:40000"
    (proc,) = h.procs
    assert proc.args[0] == "wireproxy" and proc.args[1] == "-c"
    conf = Path(proc.args[2]).read_text()
    assert f"WGConfig = {h.profile}" in conf and "[Socks5]\nBindAddress = 127.0.0.1:40000" in conf
    assert "[http]\nBindAddress = 127.0.0.1:40001" in conf and h.warp.http_proxy == "http://127.0.0.1:40001"
    assert "secret" not in conf  # the profile is referenced, never copied


def test_restart_starts_a_new_session(tmp_path: Path) -> None:
    h = Harness(tmp_path, [TRACE_ON, TRACE_ON])
    h.warp.start()
    h.warp.restart()
    assert [p.terminated for p in h.procs] == [True, False] and h.warp.sessions == 2 and h.warp.ready


def test_no_tunnel_in_time_is_an_error_and_wireproxy_is_stopped(tmp_path: Path) -> None:
    h = Harness(tmp_path, [])
    with pytest.raises(WarpError, match="did not come up"):
        h.warp.start()
    assert h.procs[0].terminated and not h.warp.ready


def test_wireproxy_exiting_is_an_error(tmp_path: Path) -> None:
    h = Harness(tmp_path, [], exit_code=1)
    with pytest.raises(WarpError, match="exited with code 1"):
        h.warp.start()


def test_a_missing_profile_is_an_error(tmp_path: Path) -> None:
    h = Harness(tmp_path, [TRACE_ON])
    h.profile.unlink()
    with pytest.raises(WarpError, match="profile"):
        h.warp.start()
    assert h.procs == []
