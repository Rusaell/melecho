from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from melecho.netutil import net_delta


@dataclass
class MetricState:
    s: float | None = None
    n_resid: int = 0
    ring: deque = field(default_factory=deque)
    last_status: str = "init"
    last_z: float = 0.0
    last_x: float | None = None
    anomaly: bool = False


class Detector:
    def __init__(self, cfg):
        self.alpha = cfg.ewma_alpha
        self.min_warmup = cfg.min_warmup_residuals
        self.z_window = cfg.z_window
        self.z_threshold = float(getattr(cfg, "z_threshold", 3.0))
        self.ignore_drops = bool(getattr(cfg, "detector_ignore_drops", True))
        self.eps = 1e-6
        self.min_sigma = {
            "cpu": float(getattr(cfg, "min_sigma_cpu", 1.0)),
            "ram": float(getattr(cfg, "min_sigma_ram", 0.5)),
            "disk": float(getattr(cfg, "min_sigma_disk", 0.5)),
            "load_1m": float(getattr(cfg, "min_sigma_load", 0.05)),
            "net_rx_bps": float(getattr(cfg, "min_sigma_net", 10240.0)),
            "net_tx_bps": float(getattr(cfg, "min_sigma_net", 10240.0)),
        }
        # Абсолютные пороги. load_1m считается динамически из nproc
        # конкретного сервера (см. _load_threshold), остальные — статичные.
        self.abs_thr = {
            "cpu": getattr(cfg, "abs_cpu", 90.0),
            "ram": getattr(cfg, "abs_ram", 90.0),
            "disk": getattr(cfg, "abs_disk", 90.0),
            "load_1m": None,      # заменяется через _load_threshold(sid)
            "net_rx_bps": None,
            "net_tx_bps": None,
        }
        # Порог load на одно ядро. Реальный порог = nproc × per_cpu.
        self.per_cpu = getattr(cfg, "abs_load_1m_per_cpu", 1.5)
        # server_id → nproc. Заполняется runtime'ом (set_nproc) при первом
        # успешном сборе, когда сервер ответил на /usr/bin/nproc. Если NULL —
        # fallback на 1 (порог = per_cpu).
        self.nproc: dict[int, int] = {}
        self.default_interval_sec: int = int(getattr(cfg, "metrics_interval_sec", 30) or 30)
        self.intervals: dict[int, int] = {}
        # server_id -> metric -> state
        self.state: dict[int, dict[str, MetricState]] = {}
        # Кандидаты на alert, которые Runtime сольёт в БД через AlertEngine.
        # Detector синхронный — а emit() асинхронный, поэтому здесь буфер.
        # Формат: {"kind": "anomaly"|"resolved", "server_id", "metric", "value", "z_score", ...}
        self.alert_candidates: list[dict] = []
        # Метрики, для которых z-score вернулся в норму и нужно закрыть алерт.
        # Храним пары (server_id, metric) с временем последнего «нормально».
        self._z_ok_since: dict[tuple[int, str], float] = {}
        self._prev_net: dict[int, tuple[int, int, str]] = {}  # rx, tx, ts

    def apply_tuning(
        self,
        *,
        z_threshold: float | None = None,
        ignore_drops: bool | None = None,
        abs_cpu: float | None = None,
        abs_ram: float | None = None,
        abs_disk: float | None = None,
        abs_load_1m_per_cpu: float | None = None,
    ) -> None:
        if z_threshold is not None:
            self.z_threshold = float(z_threshold)
        if ignore_drops is not None:
            self.ignore_drops = bool(ignore_drops)
        if abs_cpu is not None:
            self.abs_thr["cpu"] = float(abs_cpu)
        if abs_ram is not None:
            self.abs_thr["ram"] = float(abs_ram)
        if abs_disk is not None:
            self.abs_thr["disk"] = float(abs_disk)
        if abs_load_1m_per_cpu is not None:
            self.per_cpu = float(abs_load_1m_per_cpu)

    def set_nproc(self, server_id: int, nproc: int) -> None:
        """Запоминает nproc сервера (читается однократно при сборке метрик)."""
        if nproc and nproc > 0:
            self.nproc[server_id] = int(nproc)

    def set_interval(self, server_id: int, interval_sec: int) -> None:
        """Запоминает фактический интервал сбора сервера для корректной метки окна."""
        if interval_sec and interval_sec > 0:
            self.intervals[server_id] = int(interval_sec)

    def _window_label(self, server_id: int) -> str:
        iv = self.intervals.get(server_id, self.default_interval_sec)
        sec = max(60, int(self.min_warmup * iv))
        if sec % 60 == 0 or sec >= 60:
            return f"{max(1, round(sec / 60))}m"
        return f"{sec}s"

    def _load_threshold(self, server_id: int) -> float:
        """Абсолютный порог для load_1m: nproc × per_cpu.

        Fallback nproc=1 — если сервер ещё ни разу не отвечал на /usr/bin/nproc
        (первый сбор, отсутствие coreutils). Тогда порог = per_cpu (1.5).
        """
        nproc = self.nproc.get(server_id, 1)
        return float(nproc) * self.per_cpu

    def reset_server(self, server_id: int) -> None:
        self.state.pop(server_id, None)
        self._prev_net.pop(server_id, None)
        self.nproc.pop(server_id, None)
        self.intervals.pop(server_id, None)
        self.alert_candidates = [c for c in self.alert_candidates if c.get("server_id") != server_id]
        for k in [k for k in self._z_ok_since if k[0] == server_id]:
            self._z_ok_since.pop(k, None)

    def drain_candidates(self, server_id: int | None = None) -> list[dict]:
        """Возвращает и очищает буфер кандидатов (все или только по server_id)."""
        if server_id is None:
            out = self.alert_candidates
            self.alert_candidates = []
            return out
        out = [c for c in self.alert_candidates if c.get("server_id") == server_id]
        self.alert_candidates = [c for c in self.alert_candidates if c.get("server_id") != server_id]
        return out

    def _bucket(self, server_id: int) -> dict[str, MetricState]:
        return self.state.setdefault(server_id, {})

    def update_metric(self, server_id: int, metric: str, x: float, ts: str, skip: bool = False) -> dict:
        if skip:
            st = self._bucket(server_id).get(metric) or MetricState()
            return {"metric": metric, "status": "skipped_reset", "anomaly": False, "z": None, "x": x}
        b = self._bucket(server_id)
        st = b.get(metric)
        if st is None:
            st = MetricState(ring=deque(maxlen=self.z_window))
            b[metric] = st
        if st.s is None:
            st.s = x
            st.n_resid = 0
            st.last_status = "seed"
            st.last_x = x
            st.anomaly = False
            st.last_z = 0.0
            return {"metric": metric, "status": "seed", "anomaly": False, "z": None, "x": x, "ewma": st.s}
        r = x - st.s
        st.s = self.alpha * x + (1 - self.alpha) * st.s
        st.ring.append(r)
        st.n_resid += 1
        st.last_x = x
        if st.n_resid < self.min_warmup:
            st.last_status = "warming_up"
            st.anomaly = False
            st.last_z = 0.0
            return {"metric": metric, "status": "warming_up", "anomaly": False, "z": None, "x": x, "ewma": st.s, "n_resid": st.n_resid}
        residuals = list(st.ring)
        n = len(residuals)
        mu = sum(residuals) / n
        if n < 2:
            var = 0.0
        else:
            var = sum((v - mu) ** 2 for v in residuals) / (n - 1)  # ddof=1
        sigma = var ** 0.5
        min_sig = self.min_sigma.get(metric, 0.0)
        eff_sigma = max(sigma, min_sig)
        z = 0.0 if eff_sigma < self.eps else (r - mu) / eff_sigma
        if metric == "load_1m":
            abs_thr = self._load_threshold(server_id)
        else:
            abs_thr = self.abs_thr.get(metric)

        is_z_anomaly = (z >= self.z_threshold) if self.ignore_drops else (abs(z) >= self.z_threshold)
        anomaly = is_z_anomaly or (abs_thr is not None and x >= abs_thr)
        st.last_status = "anomaly" if anomaly else "ok"
        st.last_z = z
        st.anomaly = anomaly
        result = {
            "metric": metric,
            "status": st.last_status,
            "anomaly": anomaly,
            "z": z,
            "x": x,
            "ewma": st.s,
            "n_resid": st.n_resid,
            "threshold": self.z_threshold,
        }

        # Auto-resolve: если z-score вернулся в норму и держится 300 с
        key = (server_id, metric)
        is_z_norm = (z < self.z_threshold) if self.ignore_drops else (abs(z) < self.z_threshold)
        if is_z_norm:
            if key not in self._z_ok_since:
                self._z_ok_since[key] = time.monotonic()
        else:
            self._z_ok_since.pop(key, None)

        # Anomaly: генерируем кандидата в буфер. Runtime сам решит, в какое
        # правило (warning/critical) его отнести — по величине z.
        if anomaly:
            self.alert_candidates.append({
                "kind": "anomaly",
                "server_id": server_id,
                "metric": metric,
                "value": x,
                "ewma": st.s,
                "z_score": z,
                "threshold": self.z_threshold,
                "window": self._window_label(server_id),
                "ts": ts,
            })
        return result

    def ingest_raw_point(self, server_id: int, point: dict, prev: dict | None) -> list[dict]:
        """point: cpu, ram, disk, net_rx, net_tx, load_avg (list), timestamp_utc. Net is cumulative."""
        out = []
        ts = point["timestamp_utc"]
        for m in ("cpu", "ram", "disk"):
            v = point.get(m)
            if v is None:
                continue
            out.append(self.update_metric(server_id, m, float(v), ts))
        load = point.get("load_avg")
        if load:
            if isinstance(load, str):
                import json
                load = json.loads(load)
            out.append(self.update_metric(server_id, "load_1m", float(load[0]), ts))
        if prev is not None and point.get("net_rx") is not None and prev.get("net_rx") is not None:
            dt = _delta_seconds(prev["timestamp_utc"], ts)
            if dt > 0:
                d_rx, reset_rx = net_delta(int(prev["net_rx"]), int(point["net_rx"]))
                d_tx, reset_tx = net_delta(int(prev["net_tx"]), int(point["net_tx"]))
                out.append(self.update_metric(server_id, "net_rx_bps", d_rx / dt, ts, skip=reset_rx))
                out.append(self.update_metric(server_id, "net_tx_bps", d_tx / dt, ts, skip=reset_tx))
        return out

    def replay(self, server_id: int, points: list[dict]) -> list[dict]:
        self.reset_server(server_id)
        last = None
        results = []
        for p in points:
            results.extend(self.ingest_raw_point(server_id, p, last))
            last = p
        return results


def _delta_seconds(a: str, b: str) -> float:
    from datetime import datetime, timezone

    def parse(s: str) -> datetime:
        s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s).astimezone(timezone.utc)

    return (parse(b) - parse(a)).total_seconds()
