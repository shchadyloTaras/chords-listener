"""Cloudflare WARP for chords-fetch: wireproxy (a userspace WireGuard client with a SOCKS5 proxy) on a wgcf
profile, so yt-dlp reaches YouTube from a WARP address instead of a Google Cloud one (YouTube asks Google Cloud
addresses to prove they are not a bot). On Cloud Run this works only with Direct VPC egress + Cloud NAT: over the
default egress the tunnel comes up but stalls on any payload over ~500 bytes (docs/CLOUD.md → YouTube clips)."""
from __future__ import annotations

import logging
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("chords.warp")

TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace"


class WarpError(Exception):
    """The WARP tunnel did not come up."""


def cloudflare_trace(proxy: str, timeout: float = 8.0) -> str:
    """Cloudflare's trace page fetched through ``proxy``: ``warp=on`` once the tunnel carries traffic."""
    import yt_dlp

    with yt_dlp.YoutubeDL({"proxy": proxy, "quiet": True, "no_warnings": True, "socket_timeout": timeout}) as ydl:
        return ydl.urlopen(TRACE_URL).read(4096).decode("utf-8", "replace")


def _trace_summary(text: str) -> str:
    """``colo=FRA loc=DE warp=on`` from a trace (never all of it: it holds the egress address)."""
    fields = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return " ".join(f"{k}={fields[k]}" for k in ("colo", "loc", "warp") if k in fields)


class Warp:
    """One wireproxy process. ``start`` blocks until the tunnel works (or raises WarpError); ``restart`` opens a
    new session, which usually comes with a new WARP address."""

    def __init__(
        self,
        profile: Path,
        *,
        port: int = 40000,
        http_port: int = 40001,
        binary: str = "wireproxy",
        ready_timeout_s: float = 30.0,
        trace: Callable[[str], str] = cloudflare_trace,
        popen: Callable[..., Any] = subprocess.Popen,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        work_dir: Optional[Path] = None,
    ) -> None:
        self.profile = profile
        self.port = port
        self.http_port = http_port
        self.binary = binary
        self.ready_timeout_s = ready_timeout_s
        self._trace, self._popen, self._sleep, self._clock = trace, popen, sleep, clock
        self._work = work_dir or Path(tempfile.mkdtemp(prefix="warp-"))
        self._proc: Any = None
        self.ready = False
        self.sessions = 0

    @property
    def proxy(self) -> str:
        return f"socks5h://127.0.0.1:{self.port}"

    @property
    def http_proxy(self) -> str:
        """The same tunnel as an HTTP (CONNECT) proxy: ffmpeg, which cuts the fragment, can't use SOCKS."""
        return f"http://127.0.0.1:{self.http_port}"

    def start(self) -> None:
        if not self.profile.is_file():
            raise WarpError(f"WARP profile not found: {self.profile}")
        self._work.mkdir(parents=True, exist_ok=True)
        conf = self._work / "wireproxy.conf"
        conf.write_text(
            f"WGConfig = {self.profile}\n\n[Socks5]\nBindAddress = 127.0.0.1:{self.port}\n\n"
            f"[http]\nBindAddress = 127.0.0.1:{self.http_port}\n"
        )
        self._proc = self._popen([self.binary, "-c", str(conf)], stdin=subprocess.DEVNULL)
        self.sessions += 1
        self._wait_ready()

    def restart(self) -> None:
        log.info("reconnecting WARP")
        self.stop()
        self.start()

    def stop(self) -> None:
        self.ready = False
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    def _wait_ready(self) -> None:
        deadline = self._clock() + self.ready_timeout_s
        last = "no answer"
        while self._clock() < deadline:
            if self._proc.poll() is not None:
                code = self._proc.returncode
                self._proc = None
                raise WarpError(f"wireproxy exited with code {code}")
            try:
                text = self._trace(self.proxy)
                if "warp=on" in text:
                    self.ready = True
                    log.info("WARP is up (%s)", _trace_summary(text))
                    return
                last = _trace_summary(text) or "no trace"
            except Exception as exc:  # the tunnel is still coming up
                last = f"{type(exc).__name__}: {str(exc)[:200]}"
            self._sleep(1.0)
        self.stop()
        raise WarpError(f"WARP did not come up in {self.ready_timeout_s:g} s ({last})")
