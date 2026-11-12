"""规划引擎进程监管：拉起 → 就绪探针 → 健康巡检 → 退避重启 → 优雅关停。

移植自 NAP `internal/modules/planning/planning.go` 的监管语义，
并补了一条 NAP 没有的健康巡检：uvicorn 假死（进程在但不响应）时
连续 3 次探针失败即杀掉重启，而不是等进程自己退出。
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time

import requests

from .config import EngineConfig, ensure_database

logger = logging.getLogger('planning')

READY_TIMEOUT = 90
RESTART_MIN_WAIT = 1
RESTART_MAX_WAIT = 30
HEALTH_INTERVAL = 10
HEALTH_FAILURES_BEFORE_KILL = 3
STOP_GRACE_SECONDS = 5


def probe_health(cfg: EngineConfig, timeout: float = 2.0) -> tuple[bool, str]:
    try:
        resp = requests.get(f'{cfg.base_url}/api/health', timeout=timeout)
    except requests.RequestException as exc:
        return False, f'健康检查失败: {exc}'
    if resp.status_code == 200:
        return True, ''
    return False, f'健康检查返回 {resp.status_code}'


class EngineSupervisor:
    def __init__(self, cfg: EngineConfig):
        self.cfg = cfg
        self.state = 'starting'
        self.last_err = ''
        self._stop = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def run(self) -> None:
        ensure_database(self.cfg)
        wait = RESTART_MIN_WAIT
        while not self._stop.is_set():
            err = self._run_once()
            if self._stop.is_set():
                break
            self.state = 'restarting'
            self.last_err = err
            logger.warning('规划引擎退出：%s（%ss 后重启）', err or '意外退出', wait)
            self._stop.wait(wait)
            wait = min(wait * 2, RESTART_MAX_WAIT)
        self.state = 'stopped'

    def stop(self, *_args) -> None:
        self._stop.set()
        with self._lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=STOP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    def _engine_env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in {'PYTHONHOME', 'PYTHONPATH'}}
        env['PYTHONUNBUFFERED'] = '1'
        env['IDCBOX_DB'] = str(self.cfg.db_path)
        return env

    def _run_once(self) -> str:
        cmd = [
            self.cfg.python, '-m', 'uvicorn', 'idcbox.api.main:create_app', '--factory',
            '--host', self.cfg.bind, '--port', str(self.cfg.port), '--log-level', 'warning',
        ]
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(self.cfg.engine_dir), env=self._engine_env(),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
        except OSError as exc:
            return f'启动失败: {exc}'
        with self._lock:
            self._proc = proc
        self.state = 'starting'
        self.last_err = ''
        threading.Thread(target=self._forward_logs, args=(proc,), daemon=True).start()

        err = self._wait_ready(proc)
        if err:
            proc.kill()
            proc.wait()
            return err
        self.state = 'up'
        logger.info('规划引擎就绪：%s（库 %s）', self.cfg.base_url, self.cfg.db_path)
        watcher = threading.Thread(target=self._health_watch, args=(proc,), daemon=True)
        watcher.start()
        code = proc.wait()
        with self._lock:
            self._proc = None
        return '' if code == 0 else f'退出码 {code}'

    def _wait_ready(self, proc: subprocess.Popen) -> str:
        deadline = time.monotonic() + READY_TIMEOUT
        last = '启动超时'
        while time.monotonic() < deadline and not self._stop.is_set():
            if proc.poll() is not None:
                return f'进程提前退出（退出码 {proc.returncode}），请检查引擎日志'
            ok, detail = probe_health(self.cfg)
            if ok:
                return ''
            last = detail
            self._stop.wait(0.3)
        return f'规划引擎未就绪: {last}'

    def _health_watch(self, proc: subprocess.Popen) -> None:
        failures = 0
        while not self._stop.is_set() and proc.poll() is None:
            self._stop.wait(HEALTH_INTERVAL)
            if self._stop.is_set() or proc.poll() is not None:
                return
            ok, _ = probe_health(self.cfg)
            failures = 0 if ok else failures + 1
            if failures >= HEALTH_FAILURES_BEFORE_KILL:
                logger.warning('规划引擎连续 %s 次健康检查失败，杀掉待重启', failures)
                proc.kill()
                return

    @staticmethod
    def _forward_logs(proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                logger.info('[planning] %s', line)