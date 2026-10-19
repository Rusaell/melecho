import {
  html,
  render,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "/static/vendor/htm-preact.module.js";

const TAB_ID = `${performance.timeOrigin}-${crypto.randomUUID()}`;
const CH = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("melecho-tab") : null;

function netDelta(prev, curr) {
  if (curr >= prev) return [curr - prev, false];
  return [curr, true];
}

function fmtNum(v, d = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(d);
}

function fmtTime(z) {
  if (!z) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(z.endsWith("Z") ? z : z + "Z"));
  } catch {
    return z;
  }
}

function windowSpec(k) {
  const ms = { "15m": 900000, "1h": 3600000, "24h": 86400000, "7d": 604800000 }[k] || 900000;
  const res = k === "24h" || k === "7d" ? "5m" : "30s";
  const from = new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { res, from };
}

function pwClass(p) {
  if (!p || p.length < 12) return "weak";
  const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length >= 16 && classes >= 3) return "strong";
  return "ok";
}

let sessionToken = sessionStorage.getItem("melecho.session") || "";

async function api(path, opts = {}) {
  const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
  if (sessionToken) headers["X-Session-Token"] = sessionToken;
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || res.statusText);
    err.code = data && data.error && data.error.code;
    err.status = res.status;
    err.body = data;
    // Backend перезапущен → сессия потеряна. Чистим токен и перезагружаем вкладку.
    // Условие `sessionToken` (а не флаг в window) защищает от бесконечного цикла:
    // после reload токена нет, повторного reload не будет.
    if (res.status === 401 && err.code === "E_SESSION" && sessionToken) {
      sessionToken = "";
      try {
        sessionStorage.removeItem("melecho.session");
      } catch {}
      location.reload();
    }
    throw err;
  }
  return data;
}

// Делегирование клика по правой зоне number-инпута.
//
// В Chromium/Brave нативная кнопка-спиннер внутри <input type="number">
// не принимает клики: либо скрыта через appearance, либо клик уходит
// в поле и просто ставит каретку. Чтобы клик в правой зоне (28px)
// гарантированно менял значение (верхняя половина — +step, нижняя —
// −step), ловим pointerdown на document. preventDefault не даёт
// браузеру перехватить клик, focus выставляем вручную.
//
// Работает для всех number-инпутов приложения: cooldown, интервал,
// retention, sudo TTL и т.д. Порядок: слушатель на фазе capture,
// чтобы опередить другие обработчики.
document.addEventListener("pointerdown", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.type !== "number" || t.disabled || t.readOnly) return;
  const r = t.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  if (dx < r.width - 28) return;      // не правая зона — обычный клик
  e.preventDefault();
  try { t.focus({ preventScroll: true }); } catch { t.focus(); }
  const step = parseFloat(t.step) || 1;
  const minV = t.min !== "" ? parseFloat(t.min) : -Infinity;
  const maxV = t.max !== "" ? parseFloat(t.max) : Infinity;
  const cur = parseFloat(t.value);
  const base = Number.isFinite(cur) ? cur : 0;
  const dir = dy < r.height / 2 ? 1 : -1;
  let next = base + dir * step;
  // Округление до шага — защита от накопления погрешности float.
  next = Math.round(next / step) * step;
  if (next < minV) next = minV;
  if (next > maxV) next = maxV;
  const s = String(next);
  if (s === t.value) return;
  t.value = s;
  t.dispatchEvent(new Event("input", { bubbles: true }));
}, true);

// Курсор над правой зоной number-инпута — pointer. CSS не умеет
// стилизовать часть элемента, поэтому переключаем через JS.
// Лёгкая оптимизация: меняем style.cursor только когда зона
// реально сменилась (кэш последнего значения на элементе).
document.addEventListener("pointermove", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.type !== "number" || t.disabled) return;
  const r = t.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const overSpin = dx >= r.width - 28;
  const want = overSpin ? "pointer" : "text";
  if (t.style.cursor !== want) t.style.cursor = want;
}, true);

// Сброс cursor при уходе с number-инпута — чтобы не осталось
// pointer от предыдущего элемента.
document.addEventListener("pointerout", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.type !== "number") return;
  if (t.style.cursor) t.style.cursor = "";
}, true);

function IconShield() {
  // Логотип Melecho из resources/melecho.svg (градиент, без фона).
  // Скопирован в static/img/melecho.svg при сборке. Отдаётся
  // FastAPI как /static/img/melecho.svg.
  return html`<img class="mark" src="/static/img/melecho.svg"
                    width="36" height="36" alt="" aria-hidden="true" />`;
}

function Banner({ kind, children }) {
  return html`<div class=${"banner " + kind}>${children}</div>`;
}

function Toast({ kind, children, onDone, timeoutMs = 3000 }) {
  useEffect(() => {
    if (!onDone) return undefined;
    const t = setTimeout(onDone, timeoutMs);
    return () => clearTimeout(t);
  }, [onDone, timeoutMs, children]);
  const cls = "toast" + (kind && kind !== "ok" ? " " + kind : "");
  return html`<div class=${cls} onClick=${onDone}>${children}</div>`;
}


function Modal({ title, onClose, children, footer }) {
  return html`<div class="modal-back" onClick=${(e) => e.target === e.currentTarget && onClose && onClose()}>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="row modal-head">
        <h3 class="h2 grow">${title}</h3>
        <button class="btn btn-ghost btn-sm" onClick=${onClose}>Закрыть</button>
      </div>
      <div class="stack modal-body">${children}</div>
      ${footer ? html`<div class="row modal-foot">${footer}</div>` : null}
    </div>
  </div>`;
}

const crosshairPlugin = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const tip = chart.tooltip;
    if (!tip || !tip.getActiveElements || tip.getActiveElements().length === 0) return;
    const el = tip.getActiveElements()[0].element;
    const area = chart.chartArea;
    ctx.save();
    ctx.strokeStyle = "rgba(157,180,200,0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    // вертикальная (X)
    ctx.beginPath();
    ctx.moveTo(el.x, area.top);
    ctx.lineTo(el.x, area.bottom);
    ctx.stroke();
    // горизонтальная (Y)
    ctx.beginPath();
    ctx.moveTo(area.left, el.y);
    ctx.lineTo(area.right, el.y);
    ctx.stroke();
    ctx.restore();
  },
};

function parseFindmnt(stdout) {
  try {
    const data = JSON.parse(stdout);
    const out = [];
    const walk = (rows) => {
      for (const r of rows || []) {
        if (!r) continue;
        if (r.target && r.fstype && r.size != null && r.used != null) {
          const pct = r.size > 0 ? (r.used / r.size) * 100 : 0;
          out.push({ target: r.target, fstype: r.fstype, size: r.size, used: r.used, avail: r.avail, pct });
        }
        if (Array.isArray(r.children)) walk(r.children);
      }
    };
    walk(data.filesystems);
    return out;
  } catch {
    return null;
  }
}

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i > 0 && v < 10 ? 1 : 0;
  return v.toFixed(digits) + " " + units[i];
}

const REAL_FS = new Set(["ext4", "xfs", "btrfs"]);

function DiskCheckResult({ step }) {
  if (!step) return html`<div class="muted">run-шаг не найден</div>`;
  const mounts = parseFindmnt(step.stdout);
  if (!mounts) {
    return html`<div class="err">Не удалось разобрать вывод findmnt как JSON</div>
      <details><summary class="muted">сырой вывод</summary><pre class="pre">${step.stdout}</pre></details>`;
  }
  const interesting = mounts.filter((m) => REAL_FS.has(m.fstype));
  const other = mounts.filter((m) => !REAL_FS.has(m.fstype));
  return html`<div class="stack">
    <div class="muted">exit ${step.exit}${step.stderr ? " · stderr: " + step.stderr.slice(0, 200) : ""}</div>
    ${interesting.length
      ? html`<table>
          <thead><tr><th>Точка</th><th>ФС</th><th>Размер</th><th>Занято</th><th>Свободно</th><th>%</th></tr></thead>
          <tbody>${interesting.map(
            (m) => html`<tr>
              <td class="mono">${m.target}</td><td>${m.fstype}</td>
              <td>${fmtBytes(m.size)}</td><td>${fmtBytes(m.used)}</td><td>${fmtBytes(m.avail)}</td>
              <td class=${m.pct > 85 ? "err" : ""}>${m.pct.toFixed(1)}%</td>
            </tr>`
          )}</tbody>
        </table>`
      : html`<div class="muted">Файловых систем ext4/xfs/btrfs не найдено</div>`}
    ${other.length
      ? html`<details><summary class="muted">прочие точки (${other.length})</summary>
          <table><tbody>${other.map(
            (m) => html`<tr>
              <td class="mono">${m.target}</td><td>${m.fstype}</td>
              <td>${m.size != null ? fmtBytes(m.size) : "—"}</td>
              <td>${m.used != null ? fmtBytes(m.used) : "—"}</td>
              <td>${m.avail != null ? fmtBytes(m.avail) : "—"}</td>
              <td>${m.size > 0 ? m.pct.toFixed(1) + "%" : "—"}</td>
            </tr>`
          )}</tbody></table>
        </details>`
      : null}
    <details><summary class="muted">сырой JSON</summary><pre class="pre">${step.stdout}</pre></details>
  </div>`;
}

function HostKeySection({ host, port, onChange }) {
  const [probeResult, setProbeResult] = useState(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeErr, setProbeErr] = useState("");
  const [manualFp, setManualFp] = useState("");
  const [manualOk, setManualOk] = useState(false);
  const [checked, setChecked] = useState(false);

  async function probe() {
    if (!host) { setProbeErr("укажите host"); return; }
    setProbeBusy(true); setProbeErr(""); setManualOk(false);
    try {
      const r = await api("/api/v1/servers/probe", {
        method: "POST",
        body: JSON.stringify({ host: host.trim(), port: Number(port) || 22 }),
      });
      setProbeResult(r);
    } catch (ex) {
      setProbeErr(ex.message);
      setProbeResult(null);
    } finally {
      setProbeBusy(false);
    }
  }

  function checkManual() {
    if (!probeResult) { setProbeErr("сначала запросите fingerprint у сервера"); return; }
    if (manualFp.trim() === probeResult.fingerprint_sha256.trim()) {
      setManualOk(true);
      setProbeErr("");
    } else {
      setManualOk(false);
      setProbeErr("fingerprint не совпадает с предъявленным сервером");
    }
  }

  const confirmed = !!probeResult && (checked || manualOk);

  useEffect(() => {
    if (confirmed) {
      onChange({
        mode: "confirmed",
        fingerprint_sha256: probeResult.fingerprint_sha256,
        key_type: probeResult.key_type || "ssh-ed25519",
        public_key: probeResult.public_key || "",
      });
    } else {
      onChange({ mode: "later", fingerprint_sha256: "", key_type: "", public_key: "" });
    }
    // onChange намеренно не в deps: родитель передаёт стабильный сеттер.
  }, [confirmed, probeResult]);

  return html`<div class="card stack">
    <h3>Host key</h3>
    <p class="muted">
      Отпечаток подтверждает, что вы подключаетесь именно к нужному серверу.
      Сверьте его с независимым каналом: в терминале на этой машине выполните
    </p>
    <code class="cmd">ssh-keyscan -t ed25519 ${host || "HOST"} | ssh-keygen -lf -</code>
    <p class="muted">
      и сравните полученную строку <span class="mono">SHA256:…</span> с предъявленной ниже.
    </p>
    <div class="row">
      <button type="button" class="btn btn-sm" disabled=${probeBusy || !host} onClick=${probe}>
        ${probeBusy ? "Запрос…" : "Запросить fingerprint у сервера"}
      </button>
    </div>
    ${probeErr ? html`<div class="err">${probeErr}</div>` : null}
    ${probeResult
      ? html`<div class="stack">
          <div>
            <div class="muted">Сервер предъявил:</div>
            <div class="fp-box mono">${probeResult.fingerprint_sha256}</div>
            <div class="muted">тип ключа: ${probeResult.key_type}</div>
          </div>
          <label class="check">
            <input type="checkbox" checked=${checked}
              onChange=${(e) => { setChecked(e.target.checked); if (e.target.checked) { setManualOk(false); setManualFp(""); } }} />
            Я сверил отпечаток по независимому каналу
          </label>
          <details>
            <summary class="muted">Или ввести эталонный fingerprint вручную</summary>
            <div class="stack" style="padding-top:8px">
              <input class="mono" placeholder="SHA256:…" value=${manualFp}
                onInput=${(e) => { setManualFp(e.target.value); setManualOk(false); }} />
              <div class="row">
                <button type="button" class="btn btn-sm" disabled=${!manualFp.trim()} onClick=${checkManual}>Проверить</button>
                ${manualOk ? html`<span class="okt">Совпадает с предъявленным</span>` : null}
              </div>
            </div>
          </details>
        </div>`
      : null}
    ${confirmed
      ? html`<div class="banner ok">Host key будет записан при создании сервера</div>`
      : html`<div class="muted">Кнопка «Добавить и подтвердить» станет активной после подтверждения. Либо используйте «Добавить и подтвердить позже».</div>`}
  </div>`;
}

// Настройки отображения метрик хранятся в localStorage. Ключ глобальный
// (не per-server): так проще, а если понадобится per-server — сделаем
// отдельным патчем с fallback на глобальные.
const WINDOW_MS = {
  "15m": 900000,
  "1h": 3600000,
  "24h": 86400000,
  "7d": 604800000,
};

// Список возможных счётчиков. Порядок в массиве — дефолтный
// порядок отображения. render(points, netUnit) → html.
const METRICS_COUNTERS = [
  { id: "cpu", label: "CPU %",
    render: (points) => html`<${LineChart} points=${points} field="cpu" />` },
  { id: "ram", label: "RAM %",
    render: (points) => html`<${LineChart} points=${points} field="ram" color="#7d9a78" />` },
  { id: "disk", label: "Disk %",
    render: (points) => html`<${LineChart} points=${points} field="disk" color="#c4a35a" yMin=${0} yMax=${100} />` },
  { id: "net_rx", label: "Сеть RX",
    render: (points, netUnit) => html`<${LineChart} points=${points} field="net_rx" net=${netUnit === "bytes_cumulative" ? "cum" : "delta"} />` },
  { id: "net_tx", label: "Сеть TX",
    render: (points, netUnit) => html`<${LineChart} points=${points} field="net_tx" net=${netUnit === "bytes_cumulative" ? "cum" : "delta"} color="#c4a35a" />` },
  { id: "load1", label: "Load 1m",
    render: (points) => html`<${LineChart} points=${points.map((p) => ({ ...p, load1: (p.load_avg || [])[0] }))} field="load1" />` },
];

function metricsWindowMs(k) {
  return WINDOW_MS[k] || WINDOW_MS["15m"];
}

// ── Хранилище настроек панели метрик ────────────────────────
// Всё per-server: у каждого сервера свои порядок, видимость,
// индивидуальные окна, cutoff и глобальное окно.
//
// Ключи v2.<sid>. При первом обращении, если v2.<sid> ещё нет,
// но есть старый глобальный ключ — переносим его значение как
// стартовое для ЭТОГО сервера (legacy не удаляем: другой сервер
// при открытии тоже получит миграцию).
//
// Значения cutoff хранятся как { "<metricId>": ms-epoch } без
// префикса serverId — сам ключ уже per-server.

const LEGACY_LAYOUT_KEY = "melecho.metricsLayout";
const LEGACY_CUTOFF_KEY = "melecho.metricsCutoff";
const LEGACY_CUTOFF_SNAP_KEY = "melecho.metricsCutoffSnapshot";
const LEGACY_GLOBAL_WINDOW_KEY = "melecho.metricsGlobalWindow";

function _layoutKey(sid) { return `melecho.metricsLayout.v2.${sid}`; }
function _cutoffKey(sid) { return `melecho.metricsCutoff.v2.${sid}`; }
function _cutoffSnapKey(sid) { return `melecho.metricsCutoffSnapshot.v2.${sid}`; }
function _globalWindowKey(sid) { return `melecho.metricsGlobalWindow.v2.${sid}`; }

function _parseLayout(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const known = new Set(METRICS_COUNTERS.map((c) => c.id));
    const seen = new Set();
    const order = [];
    for (const id of (Array.isArray(parsed.order) ? parsed.order : [])) {
      if (known.has(id) && !seen.has(id)) { order.push(id); seen.add(id); }
    }
    for (const c of METRICS_COUNTERS) {
      if (!seen.has(c.id)) order.push(c.id);
    }
    const hidden = (Array.isArray(parsed.hidden) ? parsed.hidden : [])
      .filter((id) => known.has(id));
    const windows = {};
    const rawWindows = parsed.windows || {};
    for (const [k, v] of Object.entries(rawWindows)) {
      if (known.has(k) && WINDOW_MS[v]) windows[k] = v;
    }
    return { order, hidden, windows };
  } catch { return null; }
}

function loadMetricsLayout(serverId) {
  const defaults = { order: METRICS_COUNTERS.map((c) => c.id), hidden: [], windows: {} };
  if (serverId == null) return defaults;
  try {
    const raw = localStorage.getItem(_layoutKey(serverId));
    if (raw) return _parseLayout(raw) || defaults;
    const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (legacy) return _parseLayout(legacy) || defaults;
    return defaults;
  } catch { return defaults; }
}

function saveMetricsLayout(serverId, layout) {
  if (serverId == null) return;
  try { localStorage.setItem(_layoutKey(serverId), JSON.stringify(layout)); } catch {}
}

// Значения cutoff — { "<metricId>": ms }. Без serverId внутри:
// per-server уже ключом.
function loadMetricsCutoff(serverId) {
  if (serverId == null) return {};
  try {
    const raw = localStorage.getItem(_cutoffKey(serverId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    }
    // Миграция из старого общего ключа: { "<sid>:<mid>": ms }.
    const legacyRaw = localStorage.getItem(LEGACY_CUTOFF_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && typeof legacy === "object") {
        const prefix = `${serverId}:`;
        const migrated = {};
        for (const [k, v] of Object.entries(legacy)) {
          if (typeof k === "string" && k.startsWith(prefix)) {
            migrated[k.slice(prefix.length)] = v;
          }
        }
        return migrated;
      }
    }
    return {};
  } catch { return {}; }
}

function saveMetricsCutoff(serverId, map) {
  if (serverId == null) return;
  try { localStorage.setItem(_cutoffKey(serverId), JSON.stringify(map)); } catch {}
}

function loadMetricsCutoffSnapshot(serverId) {
  if (serverId == null) return null;
  try {
    const raw = localStorage.getItem(_cutoffSnapKey(serverId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : null;
    }
    const legacyRaw = localStorage.getItem(LEGACY_CUTOFF_SNAP_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (legacy && typeof legacy === "object") {
        const prefix = `${serverId}:`;
        const migrated = {};
        for (const [k, v] of Object.entries(legacy)) {
          if (typeof k === "string" && k.startsWith(prefix)) {
            migrated[k.slice(prefix.length)] = v;
          }
        }
        return Object.keys(migrated).length > 0 ? migrated : null;
      }
    }
    return null;
  } catch { return null; }
}

function saveMetricsCutoffSnapshot(serverId, map) {
  if (serverId == null) return;
  try {
    if (map == null) localStorage.removeItem(_cutoffSnapKey(serverId));
    else localStorage.setItem(_cutoffSnapKey(serverId), JSON.stringify(map));
  } catch {}
}

function loadMetricsGlobalWindow(serverId) {
  if (serverId == null) return "15m";
  try {
    const v = localStorage.getItem(_globalWindowKey(serverId));
    if (v && WINDOW_MS[v]) return v;
    const legacy = localStorage.getItem(LEGACY_GLOBAL_WINDOW_KEY);
    if (legacy && WINDOW_MS[legacy]) return legacy;
    return "15m";
  } catch { return "15m"; }
}

function saveMetricsGlobalWindow(serverId, w) {
  if (serverId == null) return;
  try { localStorage.setItem(_globalWindowKey(serverId), w); } catch {}
}

function filterPointsForMetric(points, windowKey, cutoffMs) {
  if (!points || points.length === 0) return points;
  if (!windowKey && !cutoffMs) return points;

  // «Сейчас» = timestamp последней загруженной точки, НЕ Date.now().
  // Иначе каждое SSE-обновление сдвигало границу окна и крайняя
  // точка «мигала». С lastPoint.ts результат детерминирован.
  let nowMs = null;
  if (windowKey) {
    try {
      nowMs = new Date(points[points.length - 1].timestamp_utc.replace("Z", "+00:00")).getTime();
    } catch { nowMs = null; }
  }
  const windowCutoff = (windowKey && nowMs != null)
    ? nowMs - metricsWindowMs(windowKey)
    : null;

  return points.filter((pt) => {
    let ts;
    try { ts = new Date(pt.timestamp_utc.replace("Z", "+00:00")).getTime(); }
    catch { return true; }
    if (windowCutoff != null && ts < windowCutoff) return false;
    if (cutoffMs != null && ts < cutoffMs) return false;
    return true;
  });
}

function LineChart({ points, field, color, unit, net, yMin, yMax }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const hasData = useMemo(() => points.some((p) => p[field] != null && !Number.isNaN(p[field])), [points, field]);
  useEffect(() => {
    const canvas = ref.current;
    const Chart = window.Chart;
    if (!canvas || !Chart) return undefined;
    if (!hasData) return undefined;
    const parent = canvas.parentElement;
    const rect = parent ? parent.getBoundingClientRect() : { width: 0, height: 0 };
    canvas.width = Math.max(360, Math.floor(rect.width) || 600);
    canvas.height = Math.max(120, Math.floor(rect.height) || 220);
    const labels = points.map((p) => fmtTime(p.timestamp_utc));
    let data = points.map((p) => p[field]);
    if (net) {
      data = points.map((p, i) => {
        if (i === 0 || p[field] == null || points[i - 1][field] == null) return null;
        if (net === "cum") {
          const [d] = netDelta(points[i - 1][field], p[field]);
          const dt = (new Date(p.timestamp_utc).getTime() - new Date(points[i - 1].timestamp_utc).getTime()) / 1000;
          return dt > 0 ? d / dt / 1024 : null;
        }
        return p[field] / 300 / 1024;
      });
    }
    if (chartRef.current) {
      try {
        chartRef.current.destroy();
      } catch (e) {
        console.error("LineChart destroy:", e);
      }
      chartRef.current = null;
    }
    try {
      chartRef.current = new Chart(canvas, {
        type: "line",
        plugins: [crosshairPlugin],
        data: {
          labels,
          datasets: [
            {
              data,
              borderColor: color || "#9db4c8",
              backgroundColor: "transparent",
              tension: 0.25,
              pointRadius: 0,
              borderWidth: 1.6,
              spanGaps: true,
            },
          ],
        },
        options: {
          responsive: false,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: "index", intersect: false },
          hover: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: "index",
              intersect: false,
              backgroundColor: "rgba(18,21,26,0.96)",
              borderColor: "rgba(157,180,200,0.45)",
              borderWidth: 1,
              titleColor: "#9aa0a6",
              bodyColor: "#e8e6e1",
              padding: 8,
              cornerRadius: 6,
              displayColors: false,
              titleFont: { size: 11 },
              bodyFont: { size: 12 },
            },
          },
          scales: {
            x: {
              ticks: { maxTicksLimit: 6, color: "#9aa0a6", font: { size: 10 } },
              grid: { color: "rgba(232,230,225,0.06)" },
            },
            y: {
              min: yMin,
              max: yMax,
              ticks: { color: "#9aa0a6", font: { size: 10 } },
              grid: { color: "rgba(232,230,225,0.06)" },
            },
          },
        },
      });
    } catch (e) {
      console.error("LineChart new Chart:", e);
    }
    return () => {
      if (chartRef.current) {
        try {
          chartRef.current.destroy();
        } catch (e) {
          console.error("LineChart cleanup destroy:", e);
        }
        chartRef.current = null;
      }
    };
  }, [points, field, color, unit, net, yMin, yMax, hasData]);

  // ResizeObserver: при изменении размера контейнера обновляем
  // размеры canvas и вызываем chart.resize. Без этого график
  // подстраивался только при следующем изменении points (SSE раз
  // в 30 сек) — визуально «залипал» после ресайза окна.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const parent = canvas.parentElement;
    if (!parent) return undefined;
    let raf = null;
    const apply = () => {
      const r = parent.getBoundingClientRect();
      const w = Math.max(360, Math.floor(r.width) || 600);
      const h = Math.max(120, Math.floor(r.height) || 220);
      const chart = chartRef.current;
      if (chart) {
        try { chart.resize(w, h); } catch { /* чарт уже разрушен */ }
      } else {
        // Чарт ещё не создан (нет данных) — просто выставляем размер
        // canvas, чтобы при появлении точек стартовать с правильного.
        canvas.width = w;
        canvas.height = h;
      }
    };
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    });
    ro.observe(parent);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return html`<div class="chart-box">
    <canvas ref=${ref}></canvas>
    ${!hasData ? html`<div class="chart-empty">Нет данных для отображения</div>` : null}
  </div>`;
}

function Spark({ values, color }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const Chart = window.Chart;
    if (!canvas || !Chart) return undefined;
    canvas.width = Math.max(160, canvas.parentElement.clientWidth || 200);
    canvas.height = 48;
    const ch = new Chart(canvas, {
      type: "line",
      data: {
        labels: values.map((_, i) => i),
        datasets: [
          {
            data: values,
            borderColor: color || "#9db4c8",
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.4,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
    return () => ch.destroy();
  }, [values, color]);
  return html`<div class="spark-box"><canvas ref=${ref}></canvas></div>`;
}

function useTabRole() {
  const [role, setRole] = useState("checking");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!CH) {
      setRole("leader");
      return undefined;
    }
    const leaderRef = { current: false };
    let gotLeader = false;
    let claims = [TAB_ID];
    let lastBeat = Date.now();
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.type === "who_is_leader" && leaderRef.current) CH.postMessage({ type: "i_am_leader", tab_id: TAB_ID });
      if (m.type === "i_am_leader") gotLeader = true;
      if (m.type === "claim") claims.push(m.tab_id);
      if (m.type === "heartbeat" && !leaderRef.current) lastBeat = Date.now();
      if (m.type === "handoff" && !leaderRef.current && m.session_token) {
        sessionToken = m.session_token;
        sessionStorage.setItem("melecho.session", sessionToken);
        leaderRef.current = true;
        setRole("leader");
        CH.postMessage({ type: "handoff_ack", tab_id: TAB_ID });
      }
    };
    CH.addEventListener("message", onMsg);
    CH.postMessage({ type: "who_is_leader", tab_id: TAB_ID });
    let beatWatch = null;
    const t1 = setTimeout(() => {
      if (gotLeader) {
        setRole("follower");
        setNote("Приложение уже открыто в другой вкладке");
        beatWatch = setInterval(() => {
          if (Date.now() - lastBeat > 5000 && !leaderRef.current) {
            setNote("Приложение было закрыто некорректно. Перезагрузите страницу или пошлите SIGUSR1 процессу");
          }
        }, 1000);
        return;
      }
      CH.postMessage({ type: "claim", tab_id: TAB_ID });
      setTimeout(() => {
        const min = claims.slice().sort()[0];
        if (min === TAB_ID) {
          leaderRef.current = true;
          setRole("leader");
        } else {
          setRole("follower");
          setNote("Приложение уже открыто в другой вкладке");
        }
      }, 100);
    }, 300);
    const hb = setInterval(() => {
      if (leaderRef.current) CH.postMessage({ type: "heartbeat", tab_id: TAB_ID });
    }, 2000);
    const onHide = () => {
      if (leaderRef.current && sessionToken) CH.postMessage({ type: "handoff", session_token: sessionToken, tab_id: TAB_ID });
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      clearTimeout(t1);
      clearInterval(hb);
      if (beatWatch) clearInterval(beatWatch);
      CH.removeEventListener("message", onMsg);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);
  return { role, note };
}

function Gate({ title, subtitle, children, header_extra }) {
  // header_extra — необязательный слот между брендом и заголовком.
  // Используется на стартовых экранах (unlock/wizard), чтобы показать
  // ProfileSwitcher: «Melecho → [профиль ▾] → Разблокировка / Первый
  // запуск». На прочих экранах (need-boot, stopped, follower) не нужен.
  return html`<div class="gate">
    <div class="panel stack">
      <div class="brand">
        <${IconShield} />
        <div>
          <h1>Melecho</h1>
          <p>${subtitle || "Локальная ИС управления Linux через SSH"}</p>
        </div>
      </div>
      ${header_extra || null}
      ${title ? html`<h2 class="h2">${title}</h2>` : null}
      ${children}
    </div>
  </div>`;
}


// ProfileSwitcher: селект профилей + кнопка «+ Новый».
// Показывается на стартовом экране (unlock/wizard). Переключение =
// POST /profiles/switch → ответ содержит свежий bootstrap → фронт
// делает location.replace с фрагментом URL, Root заново получает
// сессию через /api/v1/session. Старая сессия при switch
// инвалидируется, поэтому перезагрузка обязательна — иначе первый
// же запрос получит 401 E_SESSION и фронт уйдёт в need-boot.
function ProfileSwitcher({ profiles, activeSlug, onSwitch, onCreate, switchBusy }) {
  const [newOpen, setNewOpen] = useState(false);
  const [impOpen, setImpOpen] = useState(false);
  if (!profiles || profiles.length === 0) return null;
  return html`<div class="stack">
    <div class="row" style="align-items:flex-end; gap:8px">
      <div class="grow">
        <label>Профиль</label>
        <select value=${activeSlug || ""}
                disabled=${!!switchBusy}
                onChange=${(e) => onSwitch(e.target.value)}>
          ${profiles.map((p) => html`<option value=${p.slug} key=${p.slug}>
            ${p.name || p.slug}
          </option>`)}
        </select>
      </div>
      <button type="button" class="btn"
              style="min-width:44px; padding:0 12px"
              disabled=${!!switchBusy}
              title="Создать новый профиль"
              onClick=${() => setNewOpen(true)}>+</button>
      <button type="button" class="btn"
              style="padding:0 12px"
              disabled=${!!switchBusy}
              title="Импортировать профиль"
              onClick=${() => setImpOpen(true)}>↓</button>
    </div>
    ${switchBusy
      ? html`<div class="muted small">Переключение…</div>`
      : null}
    ${newOpen
      ? html`<${NewProfileModal}
            onClose=${() => setNewOpen(false)}
            onCreate=${async (name) => {
              setNewOpen(false);
              await onCreate(name);
            }} />`
      : null}
    ${impOpen
      ? html`<${ImportProfileModal} onClose=${() => setImpOpen(false)} />`
      : null}
  </div>`;
}


// Модалка создания профиля. Имя — пользовательское; slug (ключ каталога)
// генерируется на бэкенде транслитом и не показывается.
function NewProfileModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    if (e) e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onCreate(clean);
    } catch (ex) {
      setErr(ex && ex.message ? ex.message : String(ex));
      setBusy(false);
    }
  }

  return html`<${Modal} title="Новый профиль" onClose=${onClose}
    footer=${html`<div class="row">
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onClose}
              disabled=${busy}>Отмена</button>
      <div class="grow"></div>
      <button type="button" class="btn btn-primary btn-sm"
              disabled=${busy || !name.trim()}
              onClick=${submit}>${busy ? "Создание…" : "Создать"}</button>
    </div>`}>
    <label>Имя профиля</label>
    <input autoFocus value=${name}
           disabled=${busy}
           placeholder="Рабочий"
           onInput=${(e) => setName(e.target.value)}
           onKeyDown=${(e) => { if (e.key === "Enter") submit(e); }} />
    <p class="muted small">
      Ключ каталога генерируется из имени автоматически (транслит).
      Имя можно поменять позже в Настройках профиля.
    </p>
    ${err ? html`<div class="err">${err}</div>` : null}
  </${Modal}>`;
}

function Wizard({ onDone, profiles, activeSlug, onSwitchProfile, onCreateProfile, switchBusy, onStopBackend }) {
  const [step, setStep] = useState("password");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 22,
    user: "",
    os_family: "ubuntu",
    auth_type: "key",
    credential: "",
    passphrase: "",
    key_path: "",
    // Локальный сервер остаётся доступен при отсутствии внешнего
    // интернета (LAN, VPN, localhost, extranet). Если все серверы
    // локальные — панель вообще не проверяет интернет.
    is_local: false,
  });
  const [tofu, setTofu] = useState(null);
  const [sid, setSid] = useState(null);
  const [hostkey, setHostkey] = useState({ mode: "later", fingerprint_sha256: "", key_type: "", public_key: "" });
  const cls = pwClass(p1);
  function setField(k, v) {
    setForm(Object.assign({}, form, { [k]: v }));
  }
  async function submitPass(e) {
    e.preventDefault();
    setErr("");
    if (p1 !== p2) {
      setErr("Пароли не совпадают");
      return;
    }
    setBusy(true);
    try {
      await api("/api/v1/unlock", { method: "POST", body: JSON.stringify({ password: p1, confirm: p2 }) });
      setStep("server");
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  async function createServer(mode) {
    setBusy(true);
    setErr("");
    try {
      const body = Object.assign({}, form, {
        hostkey_mode: mode,
        fingerprint_sha256: hostkey.fingerprint_sha256,
        key_type: hostkey.key_type,
        public_key: hostkey.public_key,
      });
      const s = sid ? { id: sid } : await api("/api/v1/servers", { method: "POST", body: JSON.stringify(body) });
      setSid(s.id);
      if (mode === "later") {
        onDone();
        return;
      }
      const r = await api("/api/v1/servers/" + s.id + "/test-connection", { method: "POST", body: "{}" });
      if (r.code === "E_TOFU") setTofu(r);
      else onDone();
    } catch (ex) {
      if (ex.code === "E_TOFU") setTofu(ex.body && ex.body.error && ex.body.error.details ? ex.body.error.details : ex.body);
      else setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveServer(e) {
    e.preventDefault();
    return createServer("confirmed");
  }

  async function saveServerLater() {
    return createServer("later");
  }
  async function confirmTofu() {
    setBusy(true);
    try {
      await api("/api/v1/servers/" + sid + "/confirm-host-key", {
        method: "POST",
        body: JSON.stringify({ fingerprint_sha256: tofu.fingerprint_sha256 }),
      });
      setTofu(null);
      onDone();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  if (step === "server") {
    return html`<${Gate} title="Первый сервер" subtitle="TOFU: fingerprint подтверждаете вы, без «продолжить» при mismatch.">
      <p class="muted">Ключ остаётся файлом на этой машине — в БД пишется только путь. Пароль пользователя SSH — если сервер его требует в дополнение к ключу.</p>
      <form class="stack" onSubmit=${saveServer}>
        <div class="server-form-row-name">
          <div class="server-form-row-name-left">
            <label>Имя</label>
            <input value=${form.name} onInput=${(e) => setField("name", e.target.value)} required />
          </div>
          <label class="check check--onoff"
                 title="Локальный сервер — доступен без внешнего интернета (LAN, VPN, localhost, extranet). Внешний — при отсутствии интернета операции приостанавливаются.">
            <input type="checkbox" checked=${form.is_local}
                   onChange=${(e) => setField("is_local", e.target.checked)} />
            <span>локальный</span>
          </label>
        </div>
        <div class="server-form-row-two">
          <div class="grow-host">
            <label>Host</label>
            <input value=${form.host} onInput=${(e) => setField("host", e.target.value)} required />
          </div>
          <div class="grow-port">
            <label>Порт</label>
            <input type="number" value=${form.port} onInput=${(e) => setField("port", Number(e.target.value))} />
          </div>
        </div>
        <label>User</label><input value=${form.user} onInput=${(e) => setField("user", e.target.value)} />
        <label>OS</label>
        <select value=${form.os_family} onChange=${(e) => setField("os_family", e.target.value)}>
          <option value="ubuntu">ubuntu</option><option value="debian">debian</option>
        </select>
        <div class="form-label-row">
          <label>Аутентификация</label>
          <label class="check check--onoff"
                 title="Включено — использовать SSH-ключ; выключено — только пароль">
            <input type="checkbox" checked=${form.auth_type === "key"}
                   onChange=${(e) => setField("auth_type", e.target.checked ? "key" : "password")} />
            <span>ключ SSH</span>
          </label>
        </div>
        ${form.auth_type === "key"
          ? html`<label>Файл ключа (путь на этой машине)</label>
              <input class="mono" placeholder="/home/you/.ssh/id_ed25519" value=${form.key_path} onInput=${(e) => setField("key_path", e.target.value)} />
              <label>Passphrase (пароль ключа, если зашифрован)</label>
              <input type="password" autocomplete="off" value=${form.passphrase} onInput=${(e) => setField("passphrase", e.target.value)} />
              <label>Пароль пользователя (если сервер его требует)</label>
              <input type="password" autocomplete="off" value=${form.credential} onInput=${(e) => setField("credential", e.target.value)} />`
          : html`<label>Пароль пользователя</label>
              <input type="password" autocomplete="off" value=${form.credential} onInput=${(e) => setField("credential", e.target.value)} required />`}
        <${HostKeySection} host=${form.host} port=${form.port} onChange=${setHostkey} />
        ${err ? html`<div class="err">${err}</div>` : null}
        <div class="row">
          <button class="btn" disabled=${busy || (!sid && hostkey.mode !== "confirmed")}>
            ${busy ? "…" : sid ? "Проверить соединение" : "Добавить и подтвердить"}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" disabled=${busy} onClick=${saveServerLater}>Добавить и подтвердить позже</button>
        </div>
      </form>
      ${tofu
        ? html`<${Modal} title="TOFU: подтвердите host key" onClose=${() => setTofu(null)}
            footer=${html`<button class="btn btn-primary" onClick=${confirmTofu}>Подтвердить отпечаток</button>`}>
            <p>Новый ключ хоста. Сверьте SHA-256 с независимым каналом.</p>
            <div class="mono">${tofu.fingerprint_sha256}</div>
          </${Modal}>`
        : null}
    </${Gate}>`;
  }
  return html`<${Gate} title="Первый запуск"
      subtitle="Мастер-пароль шифрует SSH-креденшелы. Потеря — безвозвратна."
      header_extra=${profiles && profiles.length
        ? html`<${ProfileSwitcher}
            profiles=${profiles}
            activeSlug=${activeSlug}
            onSwitch=${onSwitchProfile}
            onCreate=${onCreateProfile}
            switchBusy=${switchBusy} />`
        : null}>
    <form class="stack" onSubmit=${submitPass}>
      <label>Мастер-пароль (≥ 12 символов)</label>
      <input id="master-password" type="password" autocomplete="new-password" value=${p1} onInput=${(e) => setP1(e.target.value)} />
      <div class=${"pw " + cls}><span></span></div>
      <label>Подтверждение</label>
      <input id="master-confirm" type="password" autocomplete="new-password" value=${p2} onInput=${(e) => setP2(e.target.value)} />
      ${err ? html`<div class="err">${err}</div>` : null}
      <p class="muted">Мастер-пароль шифрует креденшелы. Потеря — безвозвратна. Минимум 12 символов.</p>
      
      <div class="row" style="gap:8px; align-items:stretch; flex-wrap:nowrap">
        ${onStopBackend
          ? html`<button type="button" class="btn btn-ghost"
                  title="Завершить процесс backend"
                  onClick=${onStopBackend}>Выйти</button>`
          : null}
        <button class="btn btn-primary grow" disabled=${busy}>${busy ? "Argon2id…" : "Создать хранилище"}</button>
      </div>
    </form>
  </${Gate}>`;
}

function Unlock({ onDone, profiles, activeSlug, onSwitchProfile, onCreateProfile, switchBusy, onStopBackend }) {
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/api/v1/unlock", { method: "POST", body: JSON.stringify({ password: p }) });
      onDone();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  return html`<${Gate} title="Разблокировка"
      header_extra=${profiles && profiles.length
        ? html`<${ProfileSwitcher}
            profiles=${profiles}
            activeSlug=${activeSlug}
            onSwitch=${onSwitchProfile}
            onCreate=${onCreateProfile}
            switchBusy=${switchBusy} />`
        : null}>
    <form class="stack" onSubmit=${submit}>
      <label>Мастер-пароль</label>
      <input id="unlock-password" type="password" autocomplete="current-password" value=${p} onInput=${(e) => setP(e.target.value)} />
      ${err ? html`<div class="err">${err}</div>` : null}
      <p class="muted">Ключ аудита хранится отдельно от БД (файл 0600).</p>
      
      <div class="row" style="gap:8px; align-items:stretch; flex-wrap:nowrap">
        ${onStopBackend
          ? html`<button type="button" class="btn btn-ghost"
                  title="Завершить процесс backend"
                  onClick=${onStopBackend}>Выйти</button>`
          : null}
        <button class="btn btn-primary grow" id="unlock-submit"
                disabled=${busy}>${busy ? "Проверка…" : "Разблокировать"}</button>
      </div>
    </form>
  </${Gate}>`;
}

// Порядок карточек серверов на дашборде. Хранится per-browser
// в localStorage (не в БД — это клиентский layout, не свойство
// сервера). Ключ версионирован на случай будущих миграций.
const SERVERS_ORDER_KEY = "melecho.serversOrder.v1";

function loadServersOrder() {
  try {
    const raw = localStorage.getItem(SERVERS_ORDER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => Number.isInteger(x));
  } catch { return []; }
}

function saveServersOrder(order) {
  try {
    localStorage.setItem(SERVERS_ORDER_KEY, JSON.stringify(order));
  } catch {}
}

// Мерджит сохранённый порядок с актуальным списком id серверов:
//   - id, которых уже нет в БД → выкидываем;
//   - id, которых нет в order (новые серверы) → в конец.
function mergeServersOrder(order, realIds) {
  const real = new Set(realIds);
  const seen = new Set();
  const out = [];
  for (const id of order) {
    if (real.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  }
  for (const id of realIds) {
    if (!seen.has(id)) { out.push(id); seen.add(id); }
  }
  return out;
}


// Единая функция бейджа статуса сервера. Используется и в Dashboard
// (карточки в сетке), и в ServerView (детальная страница). Порядок
// приоритетов: mismatch > не подтверждён > заморожен > недоступен >
// аномалия > ok. Заморозка = внешний сервер при отсутствии интернета.
function serverStatusBadge(srv, internetOffline) {
  if (!srv) return null;
  const isFrozen = !!internetOffline && !srv.is_local;
  if (srv.host_key_mismatch_at) {
    return html`<span class="badge danger" title="Host key не совпадает с сохранённым">host key</span>`;
  }
  if (!srv.hostkey) {
    return html`<span class="badge warn" title="Host key не подтверждён">не подтверждён</span>`;
  }
  if (isFrozen) {
    return html`<span class="badge warn" title="Нет интернета. Метрики заморожены. Зайдите внутрь для деталей.">заморожен</span>`;
  }
  if (srv.collect_error && !srv.collect_error.startsWith("E_HOSTKEY")) {
    return html`<span class="badge warn" title=${srv.collect_error}>недоступен</span>`;
  }
  if (srv.anomaly) {
    return html`<span class="badge danger">аномалия</span>`;
  }
  return html`<span class="badge ok">ok</span>`;
}

function Dashboard({ onOpen, llmEnabled, onOpenAlerts, internetOffline }) {
  const [data, setData] = useState(null);
  const [anoms, setAnoms] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(null);
  const [tofu, setTofu] = useState(null);
  // Режим редактирования порядка карточек.
  const [editing, setEditing] = useState(false);
  // Порядок id серверов, per-browser.
  const [order, setOrder] = useState(() => loadServersOrder());

  async function load() {
    try {
      setData(await api("/api/v1/dashboard/summary"));
      const a = await api("/api/v1/llm/anomalies");
      setAnoms(a.items || []);
    } catch (ex) {
      setErr(ex.message);
    }
  }
  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  // SSE: любая новая точка метрики → лёгкий refetch дашборда.
  // Дебаунс 400 мс: при N серверах все точки приходят пачкой,
  // схлопываем в один запрос. Таймер не сбрасываем на heartbeat —
  // слушаем только melecho:metric-event.
  useEffect(() => {
    let timer = null;
    const onEv = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { load().catch(() => {}); }, 400);
    };
    window.addEventListener("melecho:metric-event", onEv);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("melecho:metric-event", onEv);
    };
  }, []);

  // При появлении/изменении data мерджим сохранённый порядок
  // с реальным списком id: новые серверы → в конец, удалённые
  // → выкинуть. Пишем в state только при реальном изменении.
  useEffect(() => {
    if (!data) return;
    const ids = data.servers.map((s) => s.id);
    const merged = mergeServersOrder(order, ids);
    if (JSON.stringify(merged) !== JSON.stringify(order)) {
      setOrder(merged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Сохраняем порядок в localStorage при каждом изменении.
  useEffect(() => { saveServersOrder(order); }, [order]);

  // Список серверов для рендера — в сохранённом порядке.
  const sortedServers = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.servers.map((s) => [s.id, s]));
    return order.map((id) => byId.get(id)).filter(Boolean);
  }, [data, order]);

  // ---------- Drag-n-drop карточек серверов (swap) ----------
  //
  // Логика: пользователь тащит карточку A. Когда курсор попадает
  // на другую карточку B (и углубляется в неё ≥ 15%), B визуально
  // сдвигается к месту A. Пока пользователь не отпустил A —
  // превью обратимо (курсор ушёл с B → B вернулась). При отпускании
  // с активным превью — A и B меняются местами (swap).
  //
  // Отличие от «сдвига колоды»: остальные карточки не двигаются.
  // Одно перемещение меняет местами ровно две карточки.
  //
  // Геометрия всех карточек снимается один раз при pointerdown —
  // это «канонические» rect'ы для hit-test, они не меняются во
  // время drag (даже когда B визуально сдвинута через transform).

  const [dragId, setDragId] = useState(null);
  const [dragCursor, setDragCursor] = useState({ x: 0, y: 0 });
  const [swapTarget, setSwapTarget] = useState(null);
  const [swapProgress, setSwapProgress] = useState(0);
  const cardRefsRef = useRef(new Map());       // id → DOM-элемент
  const cardsSnapshotRef = useRef(new Map());  // id → DOMRect на момент pointerdown
  const dragRef = useRef(null);                // {id, offsetX, offsetY, startRect}
  // FLIP при release: снимок визуальных позиций до смены order.
  const preReleaseRectsRef = useRef(null);
  // Идентификатор карточки, которую тащили в момент release.
  // Используется в FLIP, чтобы не «втягивать» её из её DOM-позиции,
  // а появлять сразу в финальном месте (там, где был ghost).
  const lastDraggingIdRef = useRef(null);

  function registerCardRef(id, el) {
    if (el) cardRefsRef.current.set(id, el);
    else cardRefsRef.current.delete(id);
  }

  function onCardPointerDown(e, id) {
    if (!editing) return;
    if (e.button !== 0) return;
    // Кнопки внутри карточки заблокированы через CSS (pointer-events:
    // none), но на всякий случай оставим проверку на случай будущих
    // интерактивных элементов.
    if (e.target.closest("button, a, input, select, textarea")) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    // Снимок геометрии всех карточек. Хит-тест во время drag —
    // по этому снимку, потому что rect'ы в DOM меняются, когда
    // карточка-цель сдвигается через transform.
    const snapshot = new Map();
    for (const [sid, sel] of cardRefsRef.current) {
      snapshot.set(sid, sel.getBoundingClientRect());
    }
    cardsSnapshotRef.current = snapshot;
    dragRef.current = {
      id,
      offsetX: e.clientX - r.left,
      offsetY: e.clientY - r.top,
      startRect: r,
      pointerId: e.pointerId,
    };
    setDragId(id);
    setDragCursor({ x: e.clientX, y: e.clientY });
    e.preventDefault();
  }

  // Хит-тест курсора по карточкам (кроме dragging). Возвращает
  // {id, progress}, где progress 0..1 — насколько глубоко курсор
  // зашёл в карточку относительно её 15%-й рамки.
  //
  // progress = 0 — курсор на границе (или вне).
  // progress ∈ (0,1) — курсор в 15%-й рамке, B сдвигается частично.
  // progress = 1 — курсор в центральной зоне, B полностью на месте A.
  function hitTestCards(cursorX, cursorY, draggingId) {
    let bestId = null;
    let bestProgress = 0;
    for (const [id, rect] of cardsSnapshotRef.current) {
      if (id === draggingId) continue;
      if (cursorX < rect.left || cursorX > rect.right) continue;
      if (cursorY < rect.top || cursorY > rect.bottom) continue;
      const insetX = rect.width * 0.15;
      const insetY = rect.height * 0.15;
      const dxEdge = Math.min(cursorX - rect.left, rect.right - cursorX);
      const dyEdge = Math.min(cursorY - rect.top, rect.bottom - cursorY);
      const px = Math.min(1, dxEdge / insetX);
      const py = Math.min(1, dyEdge / insetY);
      const progress = Math.min(px, py);
      if (progress > bestProgress) {
        bestProgress = progress;
        bestId = id;
      }
    }
    return { id: bestId, progress: bestProgress };
  }

  // FLIP при release: React переставляет DOM-узлы (смена order),
  // и без этого карточки мгновенно оказываются в новых позициях.
  // Снимаем «до» в pointerup, здесь применяем translate от старой
  // позиции к новой + transition → 0.
  useLayoutEffect(() => {
    if (!editing) return;
    const prev = preReleaseRectsRef.current;
    if (!prev) return;
    preReleaseRectsRef.current = null;
    const excluded = lastDraggingIdRef.current;
    lastDraggingIdRef.current = null;

    const cur = new Map();
    for (const [id, el] of cardRefsRef.current) {
      cur.set(id, el.getBoundingClientRect());
    }
    for (const [id, after] of cur) {
      if (id === excluded) continue;
      const before = prev.get(id);
      if (!before) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const el = cardRefsRef.current.get(id);
      if (!el) continue;
      // У target-карточки был inline transform от drag-preview —
      // сбрасываем его, чтобы FLIP стартовал от чистой позиции.
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.transform = "";
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, editing]);

  // Глобальные pointermove/pointerup во время drag.
  useEffect(() => {
    if (dragId == null) return undefined;
    function onMove(e) {
      const d = dragRef.current;
      if (!d) return;
      setDragCursor({ x: e.clientX, y: e.clientY });
      const hit = hitTestCards(e.clientX, e.clientY, d.id);
      setSwapTarget(hit.id);
      setSwapProgress(hit.progress);
    }
    function onUp() {
      const d = dragRef.current;
      if (!d) return;
      // FLIP-снимок: визуальные позиции всех карточек прямо сейчас
      // (у target-карточки inline transform уже в силе — значит
      // её rect сдвинут; это и нужно для корректного FLIP).
      const prevRects = new Map();
      for (const [id, el] of cardRefsRef.current) {
        prevRects.set(id, el.getBoundingClientRect());
      }
      lastDraggingIdRef.current = d.id;

      // Swap только если превью было на 100%.
      if (swapTarget != null && swapProgress >= 1) {
        preReleaseRectsRef.current = prevRects;
        setOrder((prev) => {
          const i = prev.indexOf(d.id);
          const j = prev.indexOf(swapTarget);
          if (i < 0 || j < 0 || i === j) return prev;
          const next = prev.slice();
          next[i] = swapTarget;
          next[j] = d.id;
          return next;
        });
      }
      dragRef.current = null;
      cardsSnapshotRef.current = new Map();
      setDragId(null);
      setSwapTarget(null);
      setSwapProgress(0);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        dragRef.current = null;
        cardsSnapshotRef.current = new Map();
        setDragId(null);
        setSwapTarget(null);
        setSwapProgress(0);
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, swapTarget, swapProgress]);

  // Глобальный cursor: grabbing на body во время drag.
  useEffect(() => {
    if (dragId == null) return undefined;
    document.body.classList.add("dragging-server");
    return () => document.body.classList.remove("dragging-server");
  }, [dragId]);

  async function askAlert(a) {
    setErr("");
    try {
      const r = await api("/api/v1/llm/explain-anomaly", {
        method: "POST",
        body: JSON.stringify({ server_id: a.server_id, metric: a.metric }),
      });
      setExplain(r);
    } catch (ex) {
      setErr(ex.message);
    }
  }
  async function probeHostKey(sid) {
    setErr("");
    try {
      const r = await api("/api/v1/servers/" + sid + "/test-connection", { method: "POST", body: "{}" });
      if (r.code === "E_TOFU") {
        setTofu({ sid, fingerprint_sha256: r.fingerprint_sha256, key_type: r.key_type });
      } else {
        await load();
      }
    } catch (ex) {
      const fp = ex.body && ex.body.error && ex.body.error.details && ex.body.error.details.fingerprint_sha256;
      if (ex.code === "E_HOSTKEY_MISMATCH" && fp) {
        setTofu({ sid, fingerprint_sha256: fp, mismatch: true });
      } else {
        setErr(ex.message);
      }
    }
  }
  async function confirmTofu() {
    try {
      await api("/api/v1/servers/" + tofu.sid + "/confirm-host-key", {
        method: "POST",
        body: JSON.stringify({ fingerprint_sha256: tofu.fingerprint_sha256 }),
      });
      setTofu(null);
      await load();
    } catch (ex) {
      setErr(ex.message);
    }
  }
  if (!data) return html`<div class="page">${err || "Загрузка…"}</div>`;
  return html`<div class="page">
    <div class="srv-head">
      <h2 class="h2">Серверы</h2>
      <div class="row">
        ${data.servers.length > 0
          ? html`<button class=${"btn btn-sm " + (editing ? "btn-primary" : "btn-ghost")}
                    onClick=${() => setEditing((v) => !v)}>
              ${editing ? "Готово" : "Редактировать"}
            </button>`
          : null}
        <button class="btn btn-sm" onClick=${() => onOpen("new")}>Добавить сервер</button>
      </div>
    </div>
    ${err ? html`<p class="err">${err}</p>` : null}
    ${anoms.length
      ? html`<div class="card">
          <div class="row">
            <h3 class="grow">Алерты</h3>
            <span class="muted">${anoms.length} активных</span>
            <button class="btn btn-sm" onClick=${() => onOpenAlerts && onOpenAlerts()}>Открыть все</button>
          </div>
          <div class="alert-list">
            ${anoms.slice(-4).map((a) => {
              // На дашборде показываем name сервера, если он есть в data.servers
              // (обычно есть). Fallback — llm_alias, потом "server-N".
              const srv = (data.servers || []).find((s) => s.id === a.server_id);
              const label = srv ? srv.name : (a.llm_alias || ("server-" + a.server_id));
              return html`<div>
                <span class=${"badge " + (a.severity === "critical" ? "danger" : a.severity === "warning" ? "warn" : "")}>${a.severity || "warn"}</span>
                ${a.title || a.metric} · ${label}
              </div>`;
            })}
          </div>
        </div>`
      : null}
    ${data.servers.length === 0
      ? html`<div class="card empty">
          <h3>Нет серверов</h3>
          <p class="muted">Local-first: ключи не покидают эту машину, на серверах нет агента. Для защиты поднимите mock-флот — два хоста, seed-метрики и аномалия CPU/load.</p>
          <button class="btn btn-primary" onClick=${() => onOpen("new")}>Добавить хост</button>
        </div>`
      : html`<div class=${"grid dashboard-grid" + (editing ? " editing" : "")}>
          ${sortedServers.map((s) => {
            const isDragging = dragId === s.id;
            const isTarget = swapTarget === s.id;
            // Заморозка: сервер внешний (не is_local) и у панели нет
            // интернета. Динамические данные (KPI, sparkline) блюрятся —
            // они устаревшие/недостоверные. Статика (имя, ip, ОС, время
            // последнего сбора, badge) не блюрится. Внутрь карточки
            // зайти можно — операция «Открыть» остаётся кликабельной.
            const isFrozen = !!internetOffline && !s.is_local;
            // Inline transform для целевой карточки: сдвиг её центра
            // к центру dragging. Масштабируется на swapProgress —
            // плавное «втягивание» при пересечении 15%.
            let inlineStyle = "";
            if (isTarget && dragId != null) {
              const aRect = cardsSnapshotRef.current.get(dragId);
              const sRect = cardsSnapshotRef.current.get(s.id);
              if (aRect && sRect) {
                const dx = (aRect.left + aRect.width / 2) - (sRect.left + sRect.width / 2);
                const dy = (aRect.top + aRect.height / 2) - (sRect.top + sRect.height / 2);
                inlineStyle = `transform: translate(${dx * swapProgress}px, ${dy * swapProgress}px);`;
              }
            }
            return html`<article
                class=${"card" + (isFrozen ? " frozen" : "") + (isDragging ? " dragging" : "") + (isTarget ? " drag-target" : "")}
                style=${inlineStyle}
                key=${s.id}
                data-server-id=${s.id}
                ref=${(el) => registerCardRef(s.id, el)}
                onPointerDown=${editing ? (e) => onCardPointerDown(e, s.id) : null}>
              <div class="row">
                <span class="card-drag" aria-hidden="true">⠿</span>
                <h3 class="grow">${s.name}</h3>
                ${serverStatusBadge(s, internetOffline)}
              </div>
              <div class="muted mono">${s.llm_alias} · ${s.host}:${s.port}</div>
              <div class="muted mono">${s.os_family}${s.last_seen_at ? " · " + fmtTime(s.last_seen_at) : ""}${s.is_local ? " · local" : ""}</div>
              <div class=${"card-dynamic" + (isFrozen ? " blurred" : "")}>
                <div class="row">
                  <div class="kpi">${fmtNum(s.cpu)}<small>CPU %</small></div>
                  <div class="kpi">${fmtNum(s.ram)}<small>RAM %</small></div>
                  <div class="kpi">${fmtNum(s.disk)}<small>Disk %</small></div>
                </div>
                <${Spark} values=${(s.sparkline_cpu || []).map((v) => v ?? 0)} />
              </div>
              ${!s.hostkey
                ? html`<div class="banner warn">Host key не подтверждён — метрики не собираются</div>
                        <button class="btn btn-primary" onClick=${() => probeHostKey(s.id)}>Подтвердить отпечаток</button>`
                : null}
              ${s.collect_error && !s.collect_error.startsWith("E_HOSTKEY") && !isFrozen ? html`<div class="err">${s.collect_error}</div>` : null}
              <button class="btn btn-primary" onClick=${() => onOpen(s.id)}>Открыть</button>
            </article>`;
          })}
        </div>`}
    ${explain
      ? html`<${Modal} title="Интерпретация аномалии" onClose=${() => setExplain(null)}>
          <div class="muted">${explain.llm_alias} · ${explain.metric} · ${explain.provider}</div>
          <p>${explain.explanation}</p>
          <div class="row">${(explain.recommendations || []).map((id) => html`<span class="badge">${id}</span>`)}</div>
        </${Modal}>`
      : null}
    ${tofu
      ? html`<${Modal} title="TOFU: подтвердите host key" onClose=${() => setTofu(null)}
          footer=${html`<button class="btn btn-primary" onClick=${confirmTofu}>Подтвердить отпечаток</button>`}>
          <p>Новый ключ хоста. Сверьте SHA-256 с независимым каналом:</p>
          <div class="mono">${tofu.fingerprint_sha256}</div>
        </${Modal}>`
      : null}
    ${dragId != null && (() => {
      const s = sortedServers.find((x) => x.id === dragId);
      const d = dragRef.current;
      if (!s || !d) return null;
      const left = dragCursor.x - d.offsetX;
      const top = dragCursor.y - d.offsetY;
      // Ghost повторяет размеры оригинала (width + height), чтобы
      // при захвате визуально не «сжимался». Внутри — та же
      // структура: имя, alias · host, KPI, sparkline.
      return html`<div class="card-ghost"
          style=${`left: ${left}px; top: ${top}px; width: ${d.startRect.width}px; height: ${d.startRect.height}px;`}>
        <div class="row">
          <span class="card-drag" aria-hidden="true">⠿</span>
          <h3 class="grow">${s.name}</h3>
          ${s.anomaly ? html`<span class="badge danger">аномалия</span>` : html`<span class="badge ok">ok</span>`}
        </div>
        <div class="muted mono">${s.llm_alias} · ${s.host}:${s.port}</div>
        <div class="muted mono">${s.os_family}${s.last_seen_at ? " · " + fmtTime(s.last_seen_at) : ""}</div>
        <div class="row">
          <div class="kpi">${fmtNum(s.cpu)}<small>CPU %</small></div>
          <div class="kpi">${fmtNum(s.ram)}<small>RAM %</small></div>
          <div class="kpi">${fmtNum(s.disk)}<small>Disk %</small></div>
        </div>
        <${Spark} values=${(s.sparkline_cpu || []).map((v) => v ?? 0)} />
      </div>`;
    })()}
  </div>`;
}

function ServerView({ id, onBack, internetOffline }) {
  const [tab, setTab] = useState("overview");
  const [srv, setSrv] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [ops, setOps] = useState([]);
  const [services, setServices] = useState(null);
  const [plan, setPlan] = useState(null);
  const [exec, setExec] = useState(null);
  const [tofu, setTofu] = useState(null);
  const [sudo, setSudo] = useState(null);
  const [explain, setExplain] = useState(null);
  const [err, setErr] = useState("");
  const [unit, setUnit] = useState("");
  const [useSudo, setUseSudo] = useState(false);
  const [lines, setLines] = useState(100);
  const [svcQ, setSvcQ] = useState("");
  const [svcPage, setSvcPage] = useState(1);
  const [allowedSet, setAllowedSet] = useState(new Set());
  const [allowedDirty, setAllowedDirty] = useState(false);
  const [savingUnits, setSavingUnits] = useState(false);
  const [rotateReason, setRotateReason] = useState("");
  const [rotateFp, setRotateFp] = useState("");
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [rotateConfirm2, setRotateConfirm2] = useState(false);
  const [planOk, setPlanOk] = useState(false);
  const [incomplete, setIncomplete] = useState([]);
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  // Переименование сервера. nameDraft — локальное значение input;
  // при загрузке сервера синхронизируем с srv.name.
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  // nproc — счётчик ядер CPU (для нормировки load_1m). Обновляется
  // вручную через /refresh-nproc, если ядра добавили на живом сервере.
  const [nprocBusy, setNprocBusy] = useState(false);
  // Переключатель «локальный/внешний»: мгновенный PATCH по клику.
  // Блокирует кнопку на время запроса, чтобы не было двойных вызовов.
  const [localBusy, setLocalBusy] = useState(false);
  // Аутентификация: локальный черновик правки. credential/passphrase
  // показываем пустыми — на бэке они зашифрованы, обратно не приходят.
  // Пользователь либо вводит новое значение, либо явно ставит чекбокс
  // «удалить сохранённый».
  const [authDraft, setAuthDraft] = useState({
    user: "",
    auth_type: "key",
    key_path: "",
    credential: "",
    passphrase: "",
    clear_credential: false,
    clear_passphrase: false,
  });
  const [authBusy, setAuthBusy] = useState(false);

  async function load() {
    const s = await api("/api/v1/servers/" + id);
    setSrv(s);
    setNameDraft(s.name || "");
    setAllowedSet(new Set(s.allowed_units || []));
    setAllowedDirty(false);
    setOps((await api("/api/v1/operations")).items);
  }
  async function loadMetrics() {
    // Обзорная вкладка — всегда 15m. Метрики грузятся отдельно в
    // MetricsView через batch-эндпоинт.
    const w = windowSpec("15m");
    const m = await api("/api/v1/servers/" + id + "/metrics?resolution=" + w.res + "&from=" + encodeURIComponent(w.from));
    setMetrics(m);
  }
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => {
    if (!id) return undefined;
    // Без явного k: loadMetrics читает fetchKRef.current. Даже если
    // effect не успел перезапуститься при смене fetchK, следующий
    // тик возьмёт актуальное окно.
    loadMetrics().catch((e) => setErr(e.message));
    const iv = setInterval(() => {
      loadMetrics().catch(() => {});
    }, 15000);
    return () => clearInterval(iv);
  }, [id]);

  // Синхронизация authDraft с текущим сервером: при первой загрузке srv
  // и при переключении на другой id. credential/passphrase всегда пустые
  // (на бэке зашифрованы, не возвращаются).
  //
  // Зависимость по srv?.id, а не по srv: каждое SSE-обновление метрик
  // перезагружает srv (last_seen_at) и сбрасывало бы введённый пароль.
  useEffect(() => {
    if (!srv) return;
    setAuthDraft({
      user: srv.user || "",
      auth_type: srv.auth_type || "key",
      key_path: srv.key_path || "",
      credential: "",
      passphrase: "",
      clear_credential: false,
      clear_passphrase: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, srv && srv.id]);

  // SSE: новая точка метрики. Реагируем только на свой server_id,
  // дебаунс 400 мс — точка на этом сервере приходит раз в 30 сек.
  // Это даёт «график обновляется сразу после сбора», не ожидая polling.
  useEffect(() => {
    let timer = null;
    const onEv = (e) => {
      const p = e && e.detail && e.detail.payload;
      if (!p || p.server_id !== Number(id)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { loadMetrics().catch(() => {}); }, 400);
    };
    window.addEventListener("melecho:metric-event", onEv);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("melecho:metric-event", onEv);
    };
  }, [id]);

  async function testConn() {
    setErr("");
    setOk("");
    setBusy(true);
    try {
      const r = await api("/api/v1/servers/" + id + "/test-connection", { method: "POST", body: "{}" });
      if (r.code === "E_TOFU") setTofu(r);
      else {
        setIncomplete(r.incomplete_metrics || []);
        setOk("Соединение установлено");
        setTimeout(() => setOk(""), 3000);
        await load();
      }
    } catch (ex) {
      if (ex.code === "E_HOSTKEY_MISMATCH") {
        setErr(ex.message);
        const fp = ex.body && ex.body.error && ex.body.error.details && ex.body.error.details.fingerprint_sha256;
        if (fp) {
          setRotateFp(fp);
          setTab("settings");
        }
      } else setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmTofu() {
    await api("/api/v1/servers/" + id + "/confirm-host-key", {
      method: "POST",
      body: JSON.stringify({ fingerprint_sha256: tofu.fingerprint_sha256 }),
    });
    setTofu(null);
    await testConn();
  }

  async function doPlan(oid, params, escalatable) {
    setErr("");
    try {
      const body = { server_id: Number(id), params };
      if (escalatable) body.use_sudo = useSudo;
      const r = await api("/api/v1/operations/" + oid + "/plan", { method: "POST", body: JSON.stringify(body) });
      setPlan({ oid, params, escalatable, ...r });
      setPlanOk(false);
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function doExec() {
    try {
      const body = {
        server_id: Number(id),
        params: plan.params,
        confirm: true,
      };
      if (plan.escalatable || plan.use_sudo) body.use_sudo = plan.use_sudo;
      const r = await api("/api/v1/operations/" + plan.oid + "/execute", { method: "POST", body: JSON.stringify(body) });
      setExec(Object.assign({}, r, { _oid: plan.oid }));
      setPlan(null);
    } catch (ex) {
      if (ex.code === "E_SUDO_REQUIRED") {
        setSudo({ alias: srv.llm_alias, pending: true });
        return;
      }
      setErr(ex.message);
    }
  }

  async function sendSudo(pw) {
    await api("/api/v1/sudo/provide", { method: "POST", body: JSON.stringify({ server_id: Number(id), password: pw }) });
    setSudo(null);
    await doExec();
  }

  async function loadServices(page) {
    const p = page || svcPage;
    const q = svcQ ? "&q=" + encodeURIComponent(svcQ) : "";
    const r = await api("/api/v1/servers/" + id + "/services?per_page=50&page=" + p + q);
    setServices(r);
    setSvcPage(r.page);
  }

  function toggleUnit(u, on) {
    const next = new Set(allowedSet);
    if (on) next.add(u);
    else next.delete(u);
    setAllowedSet(next);
    setAllowedDirty(true);
  }

  async function saveAllowedUnits() {
    setErr("");
    setSavingUnits(true);
    try {
      await api("/api/v1/servers/" + id + "/allowed-units", {
        method: "PUT",
        body: JSON.stringify({ allowed_units: [...allowedSet] }),
      });
      setAllowedDirty(false);
      await load();
      await loadServices();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSavingUnits(false);
    }
  }

  function cancelAllowed() {
    setAllowedSet(new Set((srv && srv.allowed_units) || []));
    setAllowedDirty(false);
  }

  async function askExplain(metric) {
    try {
      let m = metric;
      if (!m) {
        const a = await api("/api/v1/llm/anomalies?server_id=" + id);
        m = (a.items && a.items[0] && a.items[0].metric) || "cpu";
      }
      const r = await api("/api/v1/llm/explain-anomaly", {
        method: "POST",
        body: JSON.stringify({ server_id: Number(id), metric: m }),
      });
      setExplain(r);
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function doRotate() {
    setErr("");
    try {
      const r = await api("/api/v1/servers/" + id + "/host-key/rotate", {
        method: "POST",
        body: JSON.stringify({ fingerprint_sha256: rotateFp, reason: rotateReason, confirm: true, confirm2: true }),
      });
      setRotateFp("");
      setRotateReason("");
      setRotateConfirm(false);
      setRotateConfirm2(false);
      await load();
      setErr("");
      if (r && r.ok) setErr("");
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function doRefreshNproc() {
    setNprocBusy(true);
    setErr("");
    try {
      const r = await api("/api/v1/servers/" + id + "/refresh-nproc", {
        method: "POST", body: "{}",
      });
      if (r.ok) {
        showToast("nproc обновлён: " + r.nproc, "ok");
        await load();
      } else {
        setErr(r.message || "не удалось обновить nproc");
      }
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setNprocBusy(false);
    }
  }

  async function doRename() {
    const next = (nameDraft || "").trim();
    if (!next) {
      setErr("имя не может быть пустым");
      return;
    }
    if (next === (srv && srv.name)) {
      // Ничего не меняется — просто молча выходим.
      return;
    }
    setRenaming(true);
    setErr("");
    try {
      const updated = await api("/api/v1/servers/" + id, {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      setSrv(updated);
      setNameDraft(updated.name || "");
      showToast("Имя сохранено", "ok");
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setRenaming(false);
    }
  }

  async function doDelete() {
    if (!confirm("Удалить сервер из локальной БД? llm_alias не переиспользуется.")) return;
    await api("/api/v1/servers/" + id, { method: "DELETE", body: "{}" });
    onBack();
  }

  // Сохранение аутентификации. Логика «что слать»:
  //   - user, auth_type: всегда (они всегда есть в форме, поле не секретное);
  //   - key_path: только если отличается (пустая строка = явная очистка);
  //   - credential: приоритет — новый ввод; иначе «удалить сохранённый»
  //     (чекбокс) → пустая строка; иначе не шлём — не трогаем бэк;
  //   - passphrase: аналогично credential.
  async function doToggleLocal(checked) {
    if (!srv) return;
    setErr("");
    setLocalBusy(true);
    try {
      const updated = await api("/api/v1/servers/" + id, {
        method: "PATCH",
        body: JSON.stringify({ is_local: !!checked }),
      });
      setSrv(updated);
      showToast(
        checked ? "Сервер помечен как локальный" : "Сервер помечен как внешний",
        "ok",
      );
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setLocalBusy(false);
    }
  }

  async function doSaveAuth() {
    if (!srv) return;
    setErr("");
    setAuthBusy(true);
    try {
      const body = {
        user: authDraft.user.trim(),
        auth_type: authDraft.auth_type,
      };
      if (authDraft.key_path !== (srv.key_path || "")) {
        body.key_path = authDraft.key_path;
      }
      if (authDraft.credential) {
        body.credential = authDraft.credential;
      } else if (authDraft.clear_credential && srv.has_credential) {
        body.credential = "";
      }
      if (authDraft.passphrase) {
        body.passphrase = authDraft.passphrase;
      } else if (authDraft.clear_passphrase && srv.has_passphrase) {
        body.passphrase = "";
      }
      const updated = await api("/api/v1/servers/" + id, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSrv(updated);
      setAuthDraft({
        user: updated.user || "",
        auth_type: updated.auth_type || "key",
        key_path: updated.key_path || "",
        credential: "",
        passphrase: "",
        clear_credential: false,
        clear_passphrase: false,
      });
      showToast("Аутентификация сохранена", "ok");
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setAuthBusy(false);
    }
  }

  if (!srv) return html`<div class="page">${err || "Загрузка…"}</div>`;
  const points = (metrics && metrics.points) || [];
  const tabs = [
    ["overview", "Обзор"],
    ["alerts", "Алерты"],
    ["metrics", "Метрики"],
    ["services", "Сервисы"],
    ["ops", "Операции"],
    ["logs", "Логи"],
    ["settings", "Настройки"],
  ];
  return html`<div class="server-page">
    <div class="server-page-top">
      <div class="server-topbar">
        <div class="srv-head">
          <div>
            <button class="btn btn-ghost btn-sm" onClick=${onBack}>← Дашборд</button>
            <div class="srv-name-row">
              <h2 class="h2">${srv.name}</h2>
              <span class="srv-name-status">${serverStatusBadge(srv, internetOffline)}</span>
            </div>
            <div class="muted mono">${srv.llm_alias} · ${srv.user}@${srv.host}:${srv.port}</div>
          </div>
          <div class="row">
            <button class="btn btn-sm" disabled=${busy} onClick=${testConn}>${busy ? "Проверка…" : "Проверить SSH"}</button>
            <button class="btn btn-sm" onClick=${() => askExplain()}>Объяснить аномалию</button>
          </div>
        </div>
        <div class="tabs">
          ${tabs.map(([k, l]) => html`<button class=${tab === k ? "on" : ""} onClick=${() => { setTab(k); if (k === "services") loadServices().catch((e) => setErr(e.message)); }}>${l}</button>`)}
        </div>
      </div>
      ${err ? html`<p class="err">${err}</p>` : null}
      ${ok ? html`<div class="toast">${ok}</div>` : null}
      ${srv && srv.host_key_mismatch_at
        ? html`<div class="banner danger">
            <div class="row">
              <span class="grow">
                <b>⚠ Host key сервера не совпадает с сохранённым.</b>
                Подключение по SSH заблокировано, метрики не собираются.
                Возможна компрометация сервера или легитимная смена ключа.
                <br /><span class="muted small">Проверка SSH доступна для диагностики.</span>
                ${srv.host_key_mismatch_fp
                  ? html`<br /><span class="mono muted">Предъявлен: ${srv.host_key_mismatch_fp}</span>`
                  : null}
              </span>
              <button class="btn btn-sm btn-primary"
                      onClick=${() => {
                        setRotateFp(srv.host_key_mismatch_fp || "");
                        setTab("settings");
                      }}>
                Сверить и принять новый ключ
              </button>
            </div>
          </div>`
        : null}
      ${srv && !srv.hostkey && !srv.host_key_mismatch_at
        ? html`<div class="banner warn">
            <div class="row">
              <span class="grow">Host key не подтверждён — метрики и сервисы недоступны. Подтвердите отпечаток.</span>
              <button class="btn btn-sm btn-primary" onClick=${testConn}>Подтвердить отпечаток</button>
            </div>
          </div>`
        : null}
      ${incomplete.length ? html`<div class="banner warn">Неполные метрики: нет ${incomplete.join(", ")}</div>` : null}
    </div>
    <div class="server-page-content">
    ${tab === "overview"
      ? html`<div class="grid">
          <div class="card"><div class="muted">CPU</div><div class="kpi">${fmtNum(points.at(-1)?.cpu)}<small>%</small></div><${Spark} values=${points.slice(-30).map((p) => p.cpu ?? 0)} color="#b794f6" /></div>
          <div class="card"><div class="muted">RAM</div><div class="kpi">${fmtNum(points.at(-1)?.ram)}<small>%</small></div><${Spark} values=${points.slice(-30).map((p) => p.ram ?? 0)} color="#7d9a78" /></div>
          <div class="card"><div class="muted">Disk</div><div class="kpi">${fmtNum(points.at(-1)?.disk)}<small>%</small></div><${Spark} values=${points.slice(-30).map((p) => p.disk ?? 0)} color="#c4a35a" /></div>
          <div class="card"><div class="muted">Load 1m</div><div class="kpi">${fmtNum((points.at(-1)?.load_avg || [])[0])}</div><${Spark} values=${points.slice(-30).map((p) => (p.load_avg || [])[0] ?? 0)} color="#7f93a8" /></div>
        </div>`
      : null}
    ${tab === "alerts"
      ? html`<${AlertsView}
          serverId=${Number(id)}
          hideHeader=${true}
          llmEnabled=${true}
          onOpenServer=${() => {}}
          onExplain=${(a) => {
            const text = [
              `Алерт на ${a.llm_alias || "server"} — ${a.title}.`,
              a.description ? `Описание: ${a.description}.` : "",
              `Severity: ${a.severity}, источник: ${a.source}.`,
              "",
              "Что может быть причиной и что стоит проверить?",
            ].filter(Boolean).join("\n");
            window.dispatchEvent(new CustomEvent("melecho:llm-ask", { detail: { text } }));
          }} />`
      : null}
    ${tab === "metrics"
      ? html`<${MetricsView} key=${id} serverId=${Number(id)} />`
      : null}
    ${tab === "services"
      ? html`<div class="stack">
          <div class="card stack">
            <h3>Разрешённые unit</h3>
            <p class="muted">
              Отметьте systemd-юниты, которые разрешено указывать в качестве параметра
              в операции <span class="mono">Перезапуск systemd-сервиса</span>.
              Без галочки операция отклонит параметр. Каждое имя проверяется через
              <span class="mono">systemctl cat</span> на сервере, поэтому в списке могут
              быть только реально существующие unit.
            </p>
            <p class="muted">В списке: <b>${allowedSet.size}</b> разрешённых unit из <b>${services ? services.total : "…"}</b> найденных.</p>
            ${allowedDirty
              ? html`<div class="banner warn">
                  <div class="row">
                    <span class="grow">Есть несохранённые изменения (${allowedSet.size} unit).</span>
                    <button class="btn btn-sm btn-primary" disabled=${savingUnits} onClick=${saveAllowedUnits}>${savingUnits ? "Сохранение…" : "Сохранить изменения"}</button>
                    <button class="btn btn-sm btn-ghost" disabled=${savingUnits} onClick=${cancelAllowed}>Отменить</button>
                  </div>
                </div>`
              : null}
          </div>
          <div class="card stack">
            <div class="row">
              <input class="grow" placeholder="поиск unit" value=${svcQ} onInput=${(e) => setSvcQ(e.target.value)} />
              <button class="btn btn-sm" onClick=${() => loadServices().catch((e) => setErr(e.message))}>Искать</button>
            </div>
            <div class="table-wrap">
            <table>
              <thead><tr><th></th><th>Unit</th><th>Active</th></tr></thead>
              <tbody>
                ${(services?.items || []).map(
                  (u) => html`<tr key=${u.unit}>
                    <td><input type="checkbox" checked=${allowedSet.has(u.unit)} onChange=${(e) => toggleUnit(u.unit, e.target.checked)} /></td>
                    <td class="mono">${u.unit}</td>
                    <td>${u.active}</td>
                  </tr>`
                )}
              </tbody>
            </table>
            </div>
            <div class="muted">${services ? services.total + " unit, стр. " + services.page : ""}</div>
            ${services && services.total > 50
              ? html`<div class="row">
                  <button class="btn btn-sm" disabled=${svcPage <= 1} onClick=${() => loadServices(svcPage - 1).catch((e) => setErr(e.message))}>Назад</button>
                  <button class="btn btn-sm" disabled=${svcPage * 50 >= services.total} onClick=${() => loadServices(svcPage + 1).catch((e) => setErr(e.message))}>Далее</button>
                </div>`
              : null}
          </div>
        </div>`
      : null}
    ${tab === "ops"
      ? html`<div class="grid">
          ${ops.filter((o) => o.valid).map(
            (o) => html`<article class="card">
              <h3>${o.name}</h3>
              <div class="muted mono">${o.id}</div>
              <div class="row">
                ${o.flags?.state_changing ? html`<span class="badge warn">state</span>` : html`<span class="badge">read</span>`}
                ${o.flags?.escalatable ? html`<span class="badge">sudo opt-in</span>` : null}
              </div>
              ${o.id === "systemd_restart"
                ? html`<input list="allowed-units-datalist" placeholder="unit (начните вводить)" value=${unit} onInput=${(e) => setUnit(e.target.value)} />
                    <datalist id="allowed-units-datalist">
                      ${Array.from(allowedSet).sort().map((u) => html`<option value=${u} />`)}
                    </datalist>`
                : null}
              ${o.id === "journalctl_view"
                ? html`<input type="number" min="1" max="1000" value=${lines} onInput=${(e) => setLines(e.target.value)} />`
                : null}
              ${o.flags?.escalatable
                ? html`<label class="check"><input type="checkbox" checked=${useSudo} onChange=${(e) => setUseSudo(e.target.checked)} /> Использовать sudo (явно)</label>`
                : null}
              <button class="btn btn-primary" onClick=${() =>
                doPlan(
                  o.id,
                  o.id === "systemd_restart" ? { unit } : o.id === "journalctl_view" ? { lines: Number(lines) } : {},
                  o.flags?.escalatable
                )}>План</button>
            </article>`
          )}
          ${ops.filter((o) => !o.valid).map((o) => html`<article class="card"><span class="badge danger">невалидна</span><div>${o.name}</div><div class="err">${o.error}</div></article>`)}
        </div>`
      : null}
    ${tab === "logs"
      ? html`<div class="card stack">
          <p class="muted">Журнал только через каталог journalctl_view — не произвольный shell.</p>
          <p class="muted">Вывод без sudo может быть неполным.</p>
          <label>Строк</label>
          <input type="number" min="1" max="1000" value=${lines} onInput=${(e) => setLines(e.target.value)} />
          <label class="check"><input type="checkbox" checked=${useSudo} onChange=${(e) => setUseSudo(e.target.checked)} /> Использовать sudo (явно)</label>
          <button class="btn" onClick=${() => doPlan("journalctl_view", { lines: Number(lines) }, true)}>План journalctl</button>
          ${exec ? html`<pre class="pre">${(exec.steps || []).map((s) => s.stdout).join("\n")}</pre>` : null}
        </div>`
      : null}
    ${tab === "settings"
      ? html`<div class="stack">
          <div class="card stack">
            <h3>Характеристики</h3>
            <p class="muted">
              nproc — число ядер CPU на сервере. Используется для нормировки
              порога Load 1m: реальный порог = nproc × 1.5. Если ядра
              добавили на живом сервере — обновите значение.
            </p>
            <div class="row">
              <span class="muted">Ядер CPU:</span>
              <span class="mono">
                ${srv.nproc != null ? srv.nproc : "— (ещё не читали)"}
              </span>
              <button class="btn btn-sm"
                      disabled=${nprocBusy}
                      onClick=${doRefreshNproc}>
                ${nprocBusy ? "Обновление…" : "Обновить nproc"}
              </button>
            </div>
          </div>
          <div class="card stack">
            <h3>Имя сервера</h3>
            <p class="muted">
              Отображается на дашборде, в алертах, в карточке. Внутренний
              идентификатор <span class="mono">${srv.llm_alias}</span> не меняется
              никогда — он используется в LLM и аудите.
            </p>
            <div class="row">
              <input class="grow" value=${nameDraft}
                     maxlength="100"
                     placeholder="например prod-01"
                     onInput=${(e) => setNameDraft(e.target.value)}
                     onKeyDown=${(e) => { if (e.key === "Enter") doRename(); }} />
              <button class="btn btn-primary"
                      disabled=${renaming
                        || !nameDraft.trim()
                        || nameDraft.trim() === (srv.name || "")}
                      onClick=${doRename}>
                ${renaming ? "Сохранение…" : "Сохранить"}
              </button>
            </div>
          <hr class="card-divider" />
            <h3>Тип сервера</h3>
            <p class="muted">
              Локальный сервер остаётся доступен при отсутствии внешнего
              интернета (LAN, VPN, localhost, extranet). Внешний — при
              сбое интернета операции на нём приостанавливаются.
            </p>
            <p class="muted small">
              Если все серверы помечены «локальный», панель вообще не
              проверяет доступ в интернет.
            </p>
            <div class="row">
              <label class="check check--onoff"
                     title=${localBusy
                       ? "Сохранение…"
                       : (srv.is_local
                           ? "Переключить на «внешний»"
                           : "Переключить на «локальный»")}>
                <input type="checkbox" checked=${!!srv.is_local}
                       disabled=${localBusy}
                       onChange=${(e) => doToggleLocal(e.target.checked)} />
                <span>${srv.is_local ? "локальный" : "внешний"}</span>
              </label>
            </div>
          </div>
          <div class="card stack">
            <h3>Аутентификация</h3>
            <p class="muted">
              Параметры SSH-подключения. Применяются при следующем коннекте.
              Пароль и passphrase шифруются DEK, обратно не отдаются.
            </p>

            <label>Пользователь</label>
            <input class="mono" value=${authDraft.user}
                   onInput=${(e) => setAuthDraft({ ...authDraft, user: e.target.value })} />

            <div class="form-label-row">
              <label>Аутентификация</label>
              <label class="check check--onoff"
                     title="Включено — использовать SSH-ключ; выключено — только пароль">
                <input type="checkbox" checked=${authDraft.auth_type === "key"}
                       onChange=${(e) => setAuthDraft({
                         ...authDraft,
                         auth_type: e.target.checked ? "key" : "password",
                       })} />
                <span>ключ SSH</span>
              </label>
            </div>

            <label>Пароль пользователя
              ${srv.has_credential && !authDraft.clear_credential && !authDraft.credential
                ? html`<span class="muted small"> · сохранён</span>`
                : null}
            </label>
            <div class="row">
              <input type="password" autocomplete="off" class="grow"
                     placeholder=${srv.has_credential && !authDraft.clear_credential
                       ? "••••••••  введите новый, чтобы заменить"
                       : "пароль пользователя SSH"}
                     value=${authDraft.credential}
                     onInput=${(e) => setAuthDraft({ ...authDraft, credential: e.target.value })} />
              ${srv.has_credential && !authDraft.clear_credential
                ? html`<button type="button" class="btn btn-sm btn-ghost"
                              title="Стереть сохранённый пароль при сохранении"
                              onClick=${() => setAuthDraft({
                                ...authDraft,
                                clear_credential: true,
                                credential: "",
                              })}>Удалить пароль</button>`
                : null}
              ${authDraft.clear_credential
                ? html`<span class="badge danger">будет удалён</span>
                       <button type="button" class="btn btn-sm btn-ghost"
                               title="Отменить удаление"
                               onClick=${() => setAuthDraft({
                                 ...authDraft,
                                 clear_credential: false,
                               })}>Отмена</button>`
                : null}
            </div>

            ${authDraft.auth_type === "key"
              ? html`<label>Файл ключа (путь на этой машине)</label>
                  <input class="mono" placeholder="/home/you/.ssh/id_ed25519"
                         value=${authDraft.key_path}
                         onInput=${(e) => setAuthDraft({ ...authDraft, key_path: e.target.value })} />
                  <label>Passphrase
                    ${srv.has_passphrase && !authDraft.clear_passphrase && !authDraft.passphrase
                      ? html`<span class="muted small"> · сохранён</span>`
                      : null}
                  </label>
                  <div class="row">
                    <input type="password" autocomplete="off" class="grow"
                           placeholder=${srv.has_passphrase && !authDraft.clear_passphrase
                             ? "••••••••  введите новую, чтобы заменить"
                             : "passphrase ключа"}
                           value=${authDraft.passphrase}
                           onInput=${(e) => setAuthDraft({ ...authDraft, passphrase: e.target.value })} />
                    ${srv.has_passphrase && !authDraft.clear_passphrase
                      ? html`<button type="button" class="btn btn-sm btn-ghost"
                                    title="Стереть сохранённую passphrase при сохранении"
                                    onClick=${() => setAuthDraft({
                                      ...authDraft,
                                      clear_passphrase: true,
                                      passphrase: "",
                                    })}>Удалить passphrase</button>`
                      : null}
                    ${authDraft.clear_passphrase
                      ? html`<span class="badge danger">будет удалена</span>
                             <button type="button" class="btn btn-sm btn-ghost"
                                     title="Отменить удаление"
                                     onClick=${() => setAuthDraft({
                                       ...authDraft,
                                       clear_passphrase: false,
                                     })}>Отмена</button>`
                      : null}
                  </div>`
              : null}

            <div class="row">
              <button class="btn btn-primary"
                      disabled=${authBusy || !authDraft.user.trim()}
                      onClick=${doSaveAuth}>
                ${authBusy ? "Сохранение…" : "Сохранить аутентификацию"}
              </button>
              <span class="muted small">
                Применяется при следующем SSH-подключении. Текущая сессия
                закроется автоматически.
              </span>
            </div>
          </div>
          <div class="card stack">
            <div class="muted">os_family: ${srv.os_family} · auth: ${srv.auth_type}</div>
            <div class="mono">allowed_units: ${(srv.allowed_units || []).join(", ") || "—"}</div>
            <p class="muted">Ротация host key — только с обоснованием, без кнопки «продолжить» при mismatch.</p>
            <label>Новый fingerprint SHA-256</label>
            <input class="mono" value=${rotateFp} onInput=${(e) => setRotateFp(e.target.value)} placeholder="SHA256:…" />
            <label>Обоснование</label>
            <input value=${rotateReason} onInput=${(e) => setRotateReason(e.target.value)} placeholder="плановая смена ключа" />
            <label class="check"><input type="checkbox" checked=${rotateConfirm} onChange=${(e) => setRotateConfirm(e.target.checked)} /> 1/2 Подтверждаю ротацию ключа (mismatch без «продолжить»)</label>
            <label class="check"><input type="checkbox" checked=${rotateConfirm2} onChange=${(e) => setRotateConfirm2(e.target.checked)} /> 2/2 Сверил новый fingerprint по независимому каналу</label>
            <button class="btn" disabled=${!rotateFp || !rotateReason.trim() || !rotateConfirm || !rotateConfirm2} onClick=${doRotate}>Ротировать host key</button>
          </div>
          <div class="card stack">
            <p class="muted">Удаление не освобождает llm_alias. Креденшелы остаются только в этой БД.</p>
            <button class="btn btn-danger" onClick=${doDelete}>Удалить сервер</button>
          </div>
        </div>`
      : null}

    </div>
    ${tofu
      ? html`<${Modal} title="TOFU: подтвердите host key" onClose=${() => setTofu(null)}
          footer=${html`<button class="btn btn-primary" onClick=${confirmTofu}>Подтвердить отпечаток</button>`}>
          <p>Новый ключ хоста. Сверьте SHA-256 с независимым каналом.</p>
          <div class="mono">${tofu.fingerprint_sha256}</div>
        </${Modal}>`
      : null}
    ${plan
      ? html`<${Modal} title=${"План: " + plan.operation_id} onClose=${() => setPlan(null)}
          footer=${html`<button class="btn btn-primary" disabled=${plan.state_changing && !planOk} onClick=${doExec}>Выполнить</button>`}>
          ${(plan.warnings || []).map((w) => html`<div class="badge warn">${w}</div>`)}
          <p class="muted">${plan.state_changing ? "Меняет состояние" : "Только чтение"}</p>
          ${(plan.steps || []).map(
            (s) => html`<div class="pre">${s.phase}: ${(s.argv || []).join(" ")}</div>`
          )}
          ${plan.state_changing
            ? html`<label class="check"><input type="checkbox" checked=${planOk} onChange=${(e) => setPlanOk(e.target.checked)} /> Подтверждаю выполнение</label>`
            : null}
        </${Modal}>`
      : null}
    ${sudo
      ? html`<${SudoBox} alias=${sudo.alias} onCancel=${() => setSudo(null)} onSend=${sendSudo} />`
      : null}
    ${exec
      ? html`<${Modal} title="Результат" onClose=${() => setExec(null)}>
          <div class="muted">${exec.duration_ms} мс · sudo ${exec.sudo_used ? "да" : "нет"}</div>
          ${exec._oid === "disk_check"
            ? html`<${DiskCheckResult} step=${(exec.steps || []).find((s) => s.phase === "run")} />`
            : (exec.steps || []).map((s) => html`<pre class="pre">${s.phase} exit ${s.exit}\n${s.stdout}${s.stderr}</pre>`)}
        </${Modal}>`
      : null}
    ${explain
      ? html`<${Modal} title="Интерпретация аномалии" onClose=${() => setExplain(null)}>
          <div class="muted">${explain.llm_alias} · ${explain.metric} · ${explain.provider}</div>
          <p>${explain.explanation}</p>
          <div class="row">${(explain.recommendations || []).map((id) => html`<span class="badge">${id}</span>`)}</div>
        </${Modal}>`
      : null}
  </div>`;
}

function SudoBox({ alias, onCancel, onSend }) {
  const [pw, setPw] = useState("");
  return html`<${Modal} title=${"Пароль sudo для " + alias} onClose=${onCancel}
    footer=${html`<button class="btn btn-primary" onClick=${() => onSend(pw)}>Передать</button>`}>
    <p class="muted">Пароль не пишется на диск, не попадает в аудит, логи и LLM. Только память процесса, TTL из настроек.</p>
    <input id="sudo-password" type="password" value=${pw} onInput=${(e) => setPw(e.target.value)} />
  </${Modal}>`;
}

function ServerAuthFields({ form, set }) {
  return html`
    <div class="form-label-row">
      <label>Аутентификация</label>
      <label class="check check--onoff"
             title="Включено — использовать SSH-ключ; выключено — только пароль">
        <input type="checkbox" checked=${form.auth_type === "key"}
               onChange=${(e) => set("auth_type", e.target.checked ? "key" : "password")} />
        <span>ключ SSH</span>
      </label>
    </div>
    ${form.auth_type === "key"
      ? html`<label>Файл ключа (путь на этой машине)</label>
          <input class="mono" placeholder="/home/you/.ssh/id_ed25519" value=${form.key_path || ""} onInput=${(e) => set("key_path", e.target.value)} />
          <label>Passphrase (пароль ключа, если зашифрован)</label>
          <input type="password" autocomplete="off" value=${form.passphrase} onInput=${(e) => set("passphrase", e.target.value)} />
          <label>Пароль пользователя (если сервер его требует)</label>
          <input type="password" autocomplete="off" value=${form.credential} onInput=${(e) => set("credential", e.target.value)} />`
      : html`<label>Пароль пользователя</label>
          <input type="password" autocomplete="off" value=${form.credential} onInput=${(e) => set("credential", e.target.value)} />`}
  `;
}

function NewServer({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 22,
    user: "",
    os_family: "ubuntu",
    auth_type: "key",
    credential: "",
    passphrase: "",
    key_path: "",
    // Локальный сервер — см. комментарий в Wizard.
    is_local: false,
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [hostkey, setHostkey] = useState({ mode: "later", fingerprint_sha256: "", key_type: "", public_key: "" });
  function set(k, v) {
    setForm(Object.assign({}, form, { [k]: v }));
  }
  async function save(mode) {
    setBusy(true);
    setErr("");
    try {
      const body = Object.assign({}, form, {
        hostkey_mode: mode,
        fingerprint_sha256: hostkey.fingerprint_sha256,
        key_type: hostkey.key_type,
        public_key: hostkey.public_key,
      });
      const s = await api("/api/v1/servers", { method: "POST", body: JSON.stringify(body) });
      onCreated(s);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  return html`<${Modal} title="Новый сервер" onClose=${onClose}
    footer=${html`<div class="row">
      <button class="btn btn-primary" disabled=${busy || hostkey.mode !== "confirmed"} onClick=${() => save("confirmed")}>Добавить и подтвердить</button>
      <button class="btn btn-ghost btn-sm" disabled=${busy} onClick=${() => save("later")}>Добавить и подтвердить позже</button>
    </div>`}>
    <div class="server-form-row-name">
      <div class="server-form-row-name-left">
        <label>Имя</label>
        <input value=${form.name} onInput=${(e) => set("name", e.target.value)} />
      </div>
      <label class="check check--onoff"
             title="Локальный сервер — доступен без внешнего интернета (LAN, VPN, localhost, extranet). Внешний — при отсутствии интернета операции приостанавливаются.">
        <input type="checkbox" checked=${form.is_local}
               onChange=${(e) => set("is_local", e.target.checked)} />
        <span>локальный</span>
      </label>
    </div>
    <div class="server-form-row-two">
      <div class="grow-host">
        <label>Host / IP</label>
        <input value=${form.host} onInput=${(e) => set("host", e.target.value)} />
      </div>
      <div class="grow-port">
        <label>Порт</label>
        <input type="number" value=${form.port} onInput=${(e) => set("port", Number(e.target.value))} />
      </div>
    </div>
    <label>User</label><input value=${form.user} onInput=${(e) => set("user", e.target.value)} />
    <label>OS</label>
    <select value=${form.os_family} onChange=${(e) => set("os_family", e.target.value)}>
      <option value="ubuntu">ubuntu</option><option value="debian">debian</option>
    </select>
    <${ServerAuthFields} form=${form} set=${set} />
    <${HostKeySection} host=${form.host} port=${form.port} onChange=${setHostkey} />
    <p class="muted">Ключ не копируется в БД — только путь. Passphrase и пароль входа шифруются DEK.</p>
    ${err ? html`<div class="err">${err}</div>` : null}
  </${Modal}>`;
}

function AuditView() {
  const [rows, setRows] = useState([]);
  const [integ, setInteg] = useState(null);
  const [err, setErr] = useState("");
  async function load() {
    setRows((await api("/api/v1/audit?limit=80")).items);
    setInteg(await api("/api/v1/audit/integrity"));
  }
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, []);
  return html`<div class="page">
    <div class="srv-head">
      <h2 class="h2">Аудит HMAC</h2>
      <div class="row">
        <a class="btn btn-sm" href="/api/v1/audit/export" onClick=${(e) => {
          e.preventDefault();
          fetch("/api/v1/audit/export", { headers: { "X-Session-Token": sessionToken } })
            .then((res) => res.blob())
            .then((blob) => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "audit.csv";
              a.click();
            })
            .catch((err) => setErr(String(err)));
        }}>CSV</a>
      </div>
    </div>
    ${integ
      ? html`<div class=${"card " + (integ.ok ? "" : "")}>
          <span class=${"badge " + (integ.ok ? "ok" : "danger")}>${integ.code}</span>
          <span> ${integ.message}</span>
        </div>`
      : null}
    ${err ? html`<p class="err">${err}</p>` : null}
    <table>
      <thead><tr><th>id</th><th>время</th><th>action</th><th>op</th><th>sudo</th><th>hmac</th></tr></thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr>
            <td>${r.id}</td>
            <td class="mono">${r.timestamp_utc}</td>
            <td>${r.action}</td>
            <td class="mono">${r.operation_id || ""}</td>
            <td>${r.sudo_used ? "да" : ""}</td>
            <td class="mono">${(r.entry_hmac || "").slice(0, 16)}…</td>
          </tr>`
        )}
      </tbody>
    </table>
  </div>`;
}

const LLM_WINDOW_LS_KEY = "melecho.llmWindow";
const LLM_WINDOW_DEFAULTS = { state: "hidden", x: null, y: null, w: 360, h: 500 };

// Автоскролл с «догоном».
//
// Зачем не хватает одного scrollTop = scrollHeight: контейнеры
// вложения и кнопок (.llm-reveal) анимируют grid-template-rows
// от 0fr к 1fr за ~320 мс. В момент setState с финальным сообщением
// их высота ещё нулевая — scrollHeight маленький, скролл доезжает
// только до старой границы. Потом reveal растёт, контент уезжает
// вниз за viewport, и пользователь видит верх вложения вместо
// конца ответа.
//
// Гоняем rAF ~420 мс после изменения, догоняя актуальный scrollHeight.
// Если пользователь сам крутит колесом/touch — прекращаем: не
// выдёргиваем из чтения.
function autoScrollFollow(el, durationMs = 420) {
  if (!el) return () => {};
  el.scrollTop = el.scrollHeight;
  const t0 = performance.now();
  let raf = null;
  let canceled = false;
  const onUserScroll = () => { canceled = true; };
  el.addEventListener("wheel", onUserScroll, { passive: true });
  el.addEventListener("touchmove", onUserScroll, { passive: true });
  const tick = () => {
    if (!el.isConnected || canceled) return;
    el.scrollTop = el.scrollHeight;
    if (performance.now() - t0 < durationMs) {
      raf = requestAnimationFrame(tick);
    }
  };
  raf = requestAnimationFrame(tick);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    el.removeEventListener("wheel", onUserScroll);
    el.removeEventListener("touchmove", onUserScroll);
  };
}

// System prompt чата собирается на backend (build_chat_system_prompt),
// чтобы всегда содержать актуальный whitelist команд. Фронт system не шлёт.

const LLM_CHAT_LS_KEY = "melecho.llmChat";
const LLM_CHAT_MAX = 60;

function loadLLMChatHistory() {
  try {
    const raw = localStorage.getItem(LLM_CHAT_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((m) =>
      m && typeof m === "object"
      && (m.role === "user" || m.role === "assistant")
      && typeof m.content === "string"
    ).map((m) => {
      const o = { role: m.role, content: m.content };
      // _mode нужен, чтобы buildSuggestHistory видел историю после F5.
      if (typeof m._mode === "string") o._mode = m._mode;
      if (m.attachment && typeof m.attachment.name === "string"
          && typeof m.attachment.content === "string") {
        o.attachment = m.attachment;
      }
      if (m.suggested_op && typeof m.suggested_op === "object") {
        o.suggested_op = m.suggested_op;
      }
      if (Array.isArray(m.suggested_alert_rules)) {
        o.suggested_alert_rules = m.suggested_alert_rules;
      }
      if (m.suggested_reaction && typeof m.suggested_reaction === "object") {
        o.suggested_reaction = m.suggested_reaction;
      }
      if (typeof m.suggested_alert_id === "number") {
        o.suggested_alert_id = m.suggested_alert_id;
      }
      if (typeof m.suggested_rule_id === "number") {
        o.suggested_rule_id = m.suggested_rule_id;
      }
      if (m.suggested_rule_patch && typeof m.suggested_rule_patch === "object") {
        o.suggested_rule_patch = m.suggested_rule_patch;
      }
      return o;
    }).slice(-LLM_CHAT_MAX);
  } catch {
    return [];
  }
}

function saveLLMChatHistory(messages) {
  try {
    const clean = messages
      // Сохраняем и сообщения с одним вложением (content пуст, но
      // attachment есть). Иначе они пропадают после F5.
      .filter((m) => !m.streaming && (m.content || m.attachment) && !m.blocked)
      .slice(-LLM_CHAT_MAX)
      .map((m) => {
        const o = { role: m.role, content: m.content || "" };
        if (typeof m._mode === "string") o._mode = m._mode;
        if (m.attachment) o.attachment = m.attachment;
        if (m.suggested_op) o.suggested_op = m.suggested_op;
        if (m.suggested_alert_rules) o.suggested_alert_rules = m.suggested_alert_rules;
        if (m.suggested_reaction) o.suggested_reaction = m.suggested_reaction;
        if (typeof m.suggested_alert_id === "number") o.suggested_alert_id = m.suggested_alert_id;
        if (typeof m.suggested_rule_id === "number") o.suggested_rule_id = m.suggested_rule_id;
        if (m.suggested_rule_patch) o.suggested_rule_patch = m.suggested_rule_patch;
        return o;
      });
    localStorage.setItem(LLM_CHAT_LS_KEY, JSON.stringify(clean));
  } catch {}
}

function loadLLMWindowState() {
  try {
    const raw = localStorage.getItem(LLM_WINDOW_LS_KEY);
    if (!raw) return Object.assign({}, LLM_WINDOW_DEFAULTS);
    const o = JSON.parse(raw);
    return Object.assign({}, LLM_WINDOW_DEFAULTS, o || {});
  } catch {
    return Object.assign({}, LLM_WINDOW_DEFAULTS);
  }
}
function saveLLMWindowState(s) {
  try { localStorage.setItem(LLM_WINDOW_LS_KEY, JSON.stringify(s)); } catch {}
}

// Режимы чата. Ключ — то, что пишет пользователь, значение — 
// что рендерится в pill и какое описание в tooltip.
// Список расширяемый: /alert, /reaction — когда появятся.
const LLM_CHAT_MODES = [
  {
    value: "chat",
    label: "chat",
    description: "Обычный чат: вопросы, объяснения, консультации.",
    placeholder: "написать…",
  },
  {
    value: "operation",
    label: "operation",
    description: "Режим создания операции: каждое сообщение — описание YAML.",
    placeholder: "описание операции…",
  },
  {
    value: "alert",
    label: "alert",
    description: "Режим правил алертов: опишите условия, LLM вернёт JSON-правила.",
    placeholder: "например: cpu > 1 — warning, cpu > 5 — critical",
  },
  {
    value: "reaction",
    label: "reaction",
    description: "Режим правил реакций: «если алерт X — запусти операцию Y».",
    placeholder: "например: при critical алерте перезапусти nginx",
  },
];

// Плавный рендер стрима: SSE-чанки накапливаются в буфере и отдаются
// в UI порциями через requestAnimationFrame. Нужно потому, что reasoning-
// модели часто присылают ВЕСЬ видимый ответ одним большим чанком после
// долгого <thought> — без сглаживания он появляется мгновенно.
//
// Скорость: буфер дренится примерно за SMOOTH_DRAIN_FRAMES кадров
// (~1.5 сек при 60 fps), но не более SMOOTH_MAX_PER_FRAME символов
// за кадр. Короткие ответы дорисовываются мгновенно.
const SMOOTH_MAX_PER_FRAME = 30;
const SMOOTH_DRAIN_FRAMES = 90;

// Локальная справка по командам. Отвечаем без LLM — экономим токены
// и гарантируем неизменность текста.
const LLM_HELP_TEXT = [
  "Доступные команды:",
  "",
  "/operation <описание>         — создать YAML-операцию",
  "/alert <описание>             — создать правила алертов",
  "/reaction <описание>          — создать правило реакции",
  "/explain <id> [вопрос]        — объяснить конкретный алерт",
  "/explain-rule <id> [вопрос]   — объяснить правило алерта",
  "/edit-rule <id> <описание>    — предложить правку правила",
  "/help                         — эта справка",
  "",
  "Режим чата выбирается в шапке окна (pill рядом с профилем).",
  "Обычные сообщения без команд идут в LLM как вопросы.",
].join("\n");

const LLM_CHAT_MODE_LS_KEY = "melecho.llmChatMode";

function loadLLMChatMode() {
  try {
    const v = localStorage.getItem(LLM_CHAT_MODE_LS_KEY);
    if (LLM_CHAT_MODES.some((m) => m.value === v)) return v;
  } catch {}
  return "chat";
}

function saveLLMChatMode(v) {
  try { localStorage.setItem(LLM_CHAT_MODE_LS_KEY, v); } catch {}
}

// Настройка «плавный стрим». Значение в localStorage, не в БД:
// это UI-предпочтение, не security-relevant. Дефолт — включено.
// Читается на каждом кадре pump'а: localStorage синхронный, а вызовов
// немного (только когда буфер непуст). Так изменение из Settings
// подхватывается мгновенно, без событий и перезагрузки.
const LLM_SMOOTH_LS_KEY = "melecho.llmSmooth.v1";

function llmSmoothEnabled() {
  try {
    const v = localStorage.getItem(LLM_SMOOTH_LS_KEY);
    return v !== "0";
  } catch { return true; }
}

function setLLMSmoothEnabled(on) {
  try { localStorage.setItem(LLM_SMOOTH_LS_KEY, on ? "1" : "0"); } catch {}
}

// Собирает контекст для suggest-запроса: последние 6 сообщений
// пользователя и ассистента В ТОМ ЖЕ режиме (_mode === modeLabel).
//
// Зачем ограничение по режиму: /alert и /reaction — разные задачи,
// смешение контекста запутает LLM. Пользователь может переключаться,
// но каждая команда видит только свою переписку.
//
// Фильтры:
//   - streaming: сообщение в процессе приёма — ещё не финал, брать нельзя;
//   - blocked: сработала канарейка S4, сообщение не уходило и не пришло;
//   - пустой content — служебная заглушка.
function buildSuggestHistory(msgs, modeLabel) {
  return msgs
    .filter((m) =>
      m && m._mode === modeLabel
      && !m.streaming && !m.blocked
      && (m.role === "user" || m.role === "assistant")
      && typeof m.content === "string" && m.content.trim()
    )
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
}

function chatModeSpec(value) {
  return LLM_CHAT_MODES.find((m) => m.value === value) || LLM_CHAT_MODES[0];
}

// Универсальный хук delayed-tooltip: показывается через 1 сек hover,
// исчезает мгновенно. Тултип рендерится в document.body — иначе его
// обрезает .modal overflow: hidden или containing block от transform.
function ModePill({ value, onChange, open, setOpen, onButtonClick }) {
  const spec = chatModeSpec(value);
  const tip = useDelayedTooltip(spec.description);
  const isActive = value !== "chat";
  return html`<div class="llm-mode-pill-wrap">
    <button ref=${tip.ref} type="button"
            onPointerEnter=${tip.onPointerEnter}
            onPointerLeave=${tip.onPointerLeave}
            class=${"llm-mode-pill " + (isActive ? "active" : "") + (open ? " open" : "")}
            onClick=${onButtonClick || null}>
      <span class="llm-mode-pill-text">${spec.label}</span>
      <span class="llm-mode-pill-arrow" aria-hidden="true">▾</span>
    </button>
    ${open
      ? html`<div class="llm-window-dropdown">
          ${LLM_CHAT_MODES.map((m) => html`<button type="button" key=${m.value}
              class=${m.value === value ? "active" : ""}
              onClick=${() => { setOpen(false); onChange(m.value); }}>
            ${m.label} <span class="muted small">· ${m.description}</span>
          </button>`)}
        </div>`
      : null}
  </div>`;
}


function useDelayedTooltip(text, delayMs = 1000) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!visible || !ref.current || !text) return undefined;
    const r = ref.current.getBoundingClientRect();
    const el = document.createElement("div");
    el.className = "tooltip-float";
    el.textContent = text;
    el.style.top = (r.bottom + 6) + "px";
    el.style.left = (r.left + r.width / 2) + "px";
    // transform: translate(-50%, 0) — по умолчанию tooltip-float имеет
    // translate(-50%, -100%), рассчитанный на bottom: calc(100% + 6px).
    // Здесь top задан явно, поэтому корректируем transform.
    el.style.transform = "translate(-50%, 0)";
    document.body.appendChild(el);
    return () => { el.remove(); };
  }, [visible, text]);

  return {
    ref,
    onPointerEnter: () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(true), delayMs);
    },
    onPointerLeave: () => {
      clearTimeout(timerRef.current);
      setVisible(false);
    },
  };
}


function LLMChatModal({
  messages, input, setInput, streaming,
  attachment, setAttachment, attachNotice,
  sendMessage, cancelStream,
  profileName, profiles, activeId, onProfileChange,
  chatMode, onChangeMode,
  onRequestClear,
  onClose,
}) {
  const [expanded, setExpanded] = useState(false);
  const [pillOpen, setPillOpen] = useState(false);
  const [modePillOpen, setModePillOpen] = useState(false);
  const chatBoxRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    try { inputRef.current && inputRef.current.focus(); } catch {}
  }, []);

  // Тот же «догоняющий» автоскролл, что и в маленьком окне.
  // Условие expanded убрано: чат в модалке рендерится и когда
  // expanded=false, и когда expanded=true — чат-контейнер один
  // и тот же, автоскролл нужен всегда.
  useEffect(() => {
    return autoScrollFollow(chatBoxRef.current);
  }, [messages, expanded]);

  useEffect(() => {
    if (!pillOpen) return undefined;
    function onDoc(e) {
      if (!e.target.closest(".llm-modal-pill-wrap")) setPillOpen(false);
    }
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [pillOpen]);
  useEffect(() => {
    if (!modePillOpen) return undefined;
    function onDoc(e) {
      if (!e.target.closest(".llm-mode-pill-wrap")) setModePillOpen(false);
    }
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [modePillOpen]);

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const canSend = !streaming && (input.trim() || attachment);

  return html`<div class="modal-back"
      onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${"modal llm-chat-modal "
                  + (expanded ? "expanded" : "")
                  + (!expanded && messages.length > 0 ? " has-reset" : "")}
         role="dialog" aria-modal="true">

      <div class="llm-chat-modal-head">
        ${profiles.length > 0
          ? html`<div class="llm-modal-pill-wrap">
              <button type="button"
                      class=${"llm-window-pill " + (pillOpen ? "open" : "")}
                      onClick=${() => setPillOpen((v) => !v)}>
                <span class="llm-window-pill-label">LLM</span>
                <span class="llm-window-pill-sep">·</span>
                <span class="llm-window-pill-text">${profileName || "профиль не задан"}</span>
                <span class="llm-window-pill-arrow" aria-hidden="true">▾</span>
              </button>
              ${pillOpen
                ? html`<div class="llm-window-dropdown">
                    ${profiles.map((p) => html`<button type="button" key=${p.id}
                        class=${p.id === activeId ? "active" : ""}
                        onClick=${() => {
                          setPillOpen(false);
                          if (p.id !== activeId) onProfileChange(p.id);
                        }}>
                      ${p.name} <span class="muted small">· ${p.provider}</span>
                    </button>`)}
                  </div>`
                : null}
            </div>`
          : html`<span class="llm-modal-profile-fallback muted small">
              ${profileName || "профиль не задан"}
            </span>`}
        <${ModePill}
            value=${chatMode}
            onChange=${onChangeMode}
            open=${modePillOpen}
            setOpen=${setModePillOpen}
            onButtonClick=${() => setModePillOpen((v) => !v)} />
        <button type="button" class="llm-window-btn" title="Закрыть"
                onClick=${onClose}>×</button>
      </div>

      <div class="llm-chat-modal-body">
        ${attachNotice
          ? html`<div class="llm-chat-modal-notice">${attachNotice}</div>`
          : null}

        ${!expanded
          ? html`<div class="llm-chat" ref=${chatBoxRef}>
              ${messages.length === 0
                ? html`<div class="llm-chat-empty">
                    Напишите сообщение, чтобы начать.
                    <br/><span class="mono">/help</span> — список команд
                  </div>`
                : messages.map((m, i) => {
                    const actions = [];
                    if (m.suggested_op) {
                      actions.push(html`<button type="button" key="op" class="llm-open-editor-btn"
                          onClick=${() => openUserOpEditorFromChat(m.suggested_op.yaml)}>
                        В редактор
                      </button>`);
                    }
                    if (m.suggested_alert_rules && m.suggested_alert_rules.length) {
                      actions.push(html`<button type="button" key="ar" class="llm-open-editor-btn"
                          onClick=${() => window.dispatchEvent(new CustomEvent(
                            "melecho:llm-create-alert-rules",
                            { detail: { rules: m.suggested_alert_rules } }))}>
                        Создать (${m.suggested_alert_rules.length})
                      </button>`);
                    }
                    if (m.suggested_reaction) {
                      actions.push(html`<button type="button" key="rx" class="llm-open-editor-btn"
                          onClick=${() => window.dispatchEvent(new CustomEvent(
                            "melecho:llm-create-reaction",
                            { detail: { rule: m.suggested_reaction } }))}>
                        В реакциях
                      </button>`);
                    }
                    if (typeof m.suggested_alert_id === "number") {
                      actions.push(html`<button type="button" key="aid" class="llm-open-editor-btn"
                          onClick=${() => window.dispatchEvent(new CustomEvent(
                            "melecho:llm-open-alert",
                            { detail: { alert_id: m.suggested_alert_id } }))}>
                        Алерт #${m.suggested_alert_id}
                      </button>`);
                    }
                    if (typeof m.suggested_rule_id === "number") {
                      actions.push(html`<button type="button" key="rid" class="llm-open-editor-btn"
                          onClick=${() => window.dispatchEvent(new CustomEvent(
                            "melecho:llm-open-rule",
                            { detail: { rule_id: m.suggested_rule_id } }))}>
                        Правило #${m.suggested_rule_id}
                      </button>`);
                    }
                    if (m.suggested_rule_patch) {
                      actions.push(html`<button type="button" key="patch" class="llm-open-editor-btn"
                          onClick=${() => window.dispatchEvent(new CustomEvent(
                            "melecho:llm-apply-rule-patch",
                            { detail: m.suggested_rule_patch }))}>
                        Применить
                      </button>`);
                    }
                    return html`<div key=${i} class=${"llm-msg-block " + m.role}>
                      <div class=${"llm-msg " + m.role
                          + (m.streaming ? " streaming" : "")
                          + (m.blocked ? " blocked" : "")}>
                        <div class=${"llm-reveal" + (m.attachment ? " shown" : "")}>
                          <div class="llm-reveal-inner">
                            ${m.attachment
                              ? html`<details class="llm-attach-inline" open>
                                  <summary>${m.attachment.name}</summary>
                                  <pre class="llm-attach-pre">${m.attachment.content}</pre>
                                </details>`
                              : null}
                          </div>
                        </div>
                        ${m.blocked ? "🚫 " : ""}${(m.content || "").replace(/\n+$/, "") || (m.streaming ? "" : (m.attachment ? "" : "…"))}
                      </div>
                      <div class=${"llm-reveal" + (actions.length ? " shown" : "")}>
                        <div class="llm-reveal-inner">
                          ${actions.length
                            ? html`<div class="llm-msg-actions">${actions}</div>`
                            : null}
                        </div>
                      </div>
                    </div>`;
                  })}
            </div>`
          : null}

        <div class="llm-chat-modal-input">
          ${attachment
            ? html`<div class="llm-attach-pill">
                <span class="llm-attach-name" title=${attachment.name}>${attachment.name}</span>
                <button type="button" class="llm-attach-x"
                        title="Убрать вложение"
                        onClick=${() => setAttachment(null)}>×</button>
              </div>`
            : null}
          <div class="llm-chat-modal-input-area">
            <textarea ref=${inputRef}
                      placeholder=${expanded
                        ? "Большой запрос — Enter отправит, Shift+Enter новая строка"
                        : chatModeSpec(chatMode).placeholder}
                      value=${input}
                      disabled=${streaming}
                      onInput=${(e) => setInput(e.target.value)}
                      onKeyDown=${onKey}></textarea>
            <div class="llm-chat-modal-actions">
              ${!expanded && messages.length > 0 && onRequestClear
                ? html`<${SymBtn} symbol="↺" tooltip="Очистить историю"
                    onClick=${onRequestClear} />`
                : null}
              <${SymBtn} symbol=${expanded ? "⤡" : "⤢"}
                  tooltip=${expanded ? "Свернуть поле ввода" : "Развернуть поле ввода"}
                  onClick=${() => setExpanded((v) => !v)} />
              ${expanded
                ? (streaming
                    ? html`<button type="button" class="btn btn-danger llm-send-text"
                                  onClick=${cancelStream}>стоп</button>`
                    : html`<button type="button" class="btn btn-primary llm-send-text"
                                  disabled=${!canSend}
                                  onClick=${sendMessage}>отправить</button>`)
                : (streaming
                    ? html`<${SymBtn} symbol="■" tooltip="Остановить"
                        onClick=${cancelStream} />`
                    : html`<${SymBtn} symbol="➤" tooltip="Отправить"
                        send=${true}
                        disabled=${!canSend}
                        onClick=${sendMessage} />`)}
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>`;
}


function openUserOpEditorFromChat(yamlText) {
  // Открываем редактор операции поверх всего через событие.
  // AppShell слушает и рендерит модалку с предзаполненным YAML.
  window.dispatchEvent(new CustomEvent("melecho:llm-open-editor", {
    detail: { yaml: yamlText },
  }));
}

function LLMWindow() {
  const [state, setState] = useState("hidden");
  const [pos, setPos] = useState({ x: null, y: null });
  const [size, setSize] = useState({ w: 380, h: 520 });
  const [profileName, setProfileName] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [pillOpen, setPillOpen] = useState(false);
  const [messages, setMessages] = useState(() => loadLLMChatHistory());
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [attachNotice, setAttachNotice] = useState("");
  const [chatMode, setChatMode] = useState(() => loadLLMChatMode());
  const [modePillOpen, setModePillOpen] = useState(false);
  const abortRef = useRef(null);
  const chatBoxRef = useRef(null);
  const inputRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const rafRef = useRef(null);
  // Буфер стрима: чанки от сервера, ещё не отрисованные.
  // streamDoneRef — сервер прислал [DONE]; pump доделывает хвост.
  const streamBufRef = useRef("");
  const streamDoneRef = useRef(false);
  const streamRafRef = useRef(null);
  // Suggest-стрим: обособленные от чата буфер, очередь событий и rAF.
  // Существуют параллельно чату, потому что /llm/suggest-* шлёт свой
  // набор событий (chunk/block/final/error), отличный от /llm/chat
  // (chunk/done/error). Смешивать их в один буфер нельзя.
  const suggestBufRef = useRef("");
  const suggestQueueRef = useRef([]);        // [{kind:"block"|"final"|"error", ...}]
  const suggestRafRef = useRef(null);
  const suggestStreamEndRef = useRef(false); // сервер закрыл поток
  const suggestApplyFinalRef = useRef(null); // callback для final-события

  const MIN_W = 280;
  const MIN_H = 220;
  const SNAP_PX = 12;
  // Высота шапки в collapsed-режиме. Используется для клампинга,
  // когда тело окна скрыто (state === "collapsed") — иначе окно
  // не могло опуститься до низа viewport, потому что клампинг шёл
  // по полной size.h, а фактическая высота была ~40px.
  const COLLAPSED_HEAD_H = 40;

  useEffect(() => {
    if (!pillOpen) return undefined;
    function onDoc(e) {
      if (!e.target.closest(".llm-window-pill, .llm-window-dropdown")) {
        setPillOpen(false);
      }
    }
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [pillOpen]);
  useEffect(() => {
    if (!modePillOpen) return undefined;
    function onDoc(e) {
      if (!e.target.closest(".llm-mode-pill-wrap, .llm-window-dropdown")) {
        setModePillOpen(false);
      }
    }
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [modePillOpen]);

  useEffect(() => {
    const s = loadLLMWindowState();
    setState(s.state || "hidden");
    setPos({ x: s.x, y: s.y });
    if (s.w && s.h) setSize({ w: s.w, h: s.h });
    loadProfiles();
    // Профили могли измениться в настройках — обновляем без F5.
    const onRefresh = () => loadProfiles();
    window.addEventListener("melecho:refresh-llm-profiles", onRefresh);
    return () => window.removeEventListener("melecho:refresh-llm-profiles", onRefresh);
  }, []);

  // Событие из AppShell: пользователь нажал «Открыть алерт #N».
  // Закрываем модалку-чат, если она открыта, чтобы AlertsView был
  // виден. Маленькое окно не трогаем — оно не перекрывает.
  useEffect(() => {
    function onOpenAlert() { setChatOpen(false); }
    window.addEventListener("melecho:llm-open-alert", onOpenAlert);
    return () => window.removeEventListener("melecho:llm-open-alert", onOpenAlert);
  }, []);

  // Внешний триггер: открыть окно и прикрепить вложение (YAML и пр.).
  // Не перезаписывает поле ввода — пользователь может дописать комментарий.
  useEffect(() => {
    function onAttach(e) {
      const d = (e && e.detail) || {};
      const name = typeof d.name === "string" ? d.name.trim() : "";
      const content = typeof d.content === "string" ? d.content : "";
      if (!name || !content) return;
      // force_mode — отправитель вложения может потребовать
      // конкретный режим (например, экспорт алерта требует chat,
      // чтобы вопрос не улетел в генератор правил).
      if (typeof d.force_mode === "string"
          && LLM_CHAT_MODES.some((m) => m.value === d.force_mode)) {
        setChatMode(d.force_mode);
      }
      setState("open");
      let next = pos;
      if (pos.x == null || pos.y == null) next = computeInitialPos();
      setPos(next);
      persist("open", next, size);
      // Сравниваем по СОДЕРЖИМОМУ: name = "yaml: <id>", id обычно не
      // меняется при правках, но YAML меняется — раньше это не давало
      // предупреждения о перезаписи, если правка не касалась первой строки.
      if (attachment && attachment.content !== content) {
        setAttachNotice("Вложение заменено: " + attachment.name);
        setTimeout(() => setAttachNotice(""), 3000);
      }
      const attObj = { name, content };
      if (typeof d.alert_id === "number" && d.alert_id > 0) {
        attObj.alert_id = d.alert_id;
      }
      setAttachment(attObj);
      setTimeout(() => {
        try { inputRef.current && inputRef.current.focus(); } catch {}
      }, 60);
    }
    window.addEventListener("melecho:llm-attach", onAttach);
    return () => window.removeEventListener("melecho:llm-attach", onAttach);
  }, [pos, size, attachment]);

  // Внешний триггер: открыть окно и подставить текст в поле ввода.
  // Например — из вкладки «Алерты» по кнопке «Объяснить».
  useEffect(() => {
    function onAsk(e) {
      const text = (e && e.detail && e.detail.text) || "";
      if (!text) return;
      setState("open");
      // Позиционирование: если ещё не задано — правый нижний угол.
      let next = pos;
      if (pos.x == null || pos.y == null) next = computeInitialPos();
      setPos(next);
      persist("open", next, size);
      setInput(text);
      setTimeout(() => {
        try { inputRef.current && inputRef.current.focus(); } catch {}
      }, 60);
    }
    window.addEventListener("melecho:llm-ask", onAsk);
    return () => window.removeEventListener("melecho:llm-ask", onAsk);
  }, [pos, size]);

  // Сохраняем историю (без streaming-заглушек).
  useEffect(() => { saveLLMChatHistory(messages); }, [messages]);
  // Режим чата хранится отдельно от истории и переживает F5.
  useEffect(() => { saveLLMChatMode(chatMode); }, [chatMode]);

  // Автоскролл к низу при добавлении сообщений и во время стрима.
  // autoScrollFollow «догоняет» раскрытие .llm-reveal (grid-rows ~320мс),
  // иначе вложение/кнопки выталкивают конец ответа за viewport.
  useEffect(() => {
    return autoScrollFollow(chatBoxRef.current);
  }, [messages, state]);

  // Автофокус на поле ввода при открытии окна.
  useEffect(() => {
    if (state === "open" && inputRef.current) {
      setTimeout(() => { try { inputRef.current.focus(); } catch {} }, 30);
    }
  }, [state]);

  // Refs на актуальные значения — чтобы listener'ы, поставленные один раз,
  // читали свежие данные. ВАЖНО: `posRef.current` присваивается ПОСЛЕ
  // объявления `currentPos` (ниже) — иначе ReferenceError из-за TDZ.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const vpRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const stateRef = useRef(state);
  stateRef.current = state;
  const posRef = useRef({ x: null, y: null });

  useEffect(() => {
    function onResize() {
      const prev = vpRef.current;
      const cur = { w: window.innerWidth, h: window.innerHeight };
      const dw = cur.w - prev.w;
      const dh = cur.h - prev.h;
      const sz = sizeRef.current;
      const p = posRef.current || { x: null, y: null };
      let x = p.x, y = p.y;
      if (x != null && y != null) {
        // Если окно было прижато к правому/нижнему краю (в пределах ~3×SNAP_PX),
        // сдвигаем его вместе с краем. В collapsed реальная высота окна —
        // только шапка, иначе bottomGap считался бы по size.h (полной
        // высоте) и детект прижатия к низу не срабатывал — окно
        // «не реагировало, потом прыгало».
        const effH = (stateRef.current === "collapsed") ? COLLAPSED_HEAD_H : sz.h;
        const rightGap = prev.w - (x + sz.w);
        const bottomGap = prev.h - (y + effH);
        if (Math.abs(rightGap - 8) < SNAP_PX * 3) x += dw;
        if (Math.abs(bottomGap - 8) < SNAP_PX * 3) y += dh;
      }
      // Сжимаем размер, если окно стало больше vp.
      const maxW = Math.max(MIN_W, cur.w - 16);
      const maxH = Math.max(MIN_H, cur.h - 16);
      const nextSize = { w: Math.min(sz.w, maxW), h: Math.min(sz.h, maxH) };
      if (nextSize.w !== sz.w || nextSize.h !== sz.h) setSize(nextSize);
      setPos((curPos) => {
        const cx = x == null ? curPos.x : x;
        const cy = y == null ? curPos.y : y;
        const clamped = clampToViewportFor(cx, cy, nextSize);
        persist(stateRef.current, clamped, nextSize);
        return clamped;
      });
      vpRef.current = cur;
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  async function loadProfiles() {
    try {
      const [p, s] = await Promise.all([
        api("/api/v1/llm/profiles"),
        api("/api/v1/settings"),
      ]);
      setProfiles(p.items || []);
      setActiveId(p.active_id);
      setProfileName(s.llm_active_profile_name || "");
    } catch {}
  }

  function persist(nextState, nextPos, nextSize) {
    const s = Object.assign(loadLLMWindowState(), {
      state: nextState,
      x: nextPos && nextPos.x,
      y: nextPos && nextPos.y,
      w: nextSize && nextSize.w,
      h: nextSize && nextSize.h,
    });
    saveLLMWindowState(s);
  }

  // Явная версия клампинга с указанной высотой — для мест, где state
  // вот-вот сменится, но stateRef ещё содержит старое значение
  // (React setState асинхронный).
  function clampToViewportForWithH(x, y, sz, h) {
    if (x == null || y == null) return { x, y };
    const maxX = Math.max(8, window.innerWidth - sz.w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    return { x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) };
  }

  function clampToViewportFor(x, y, sz) {
    if (x == null || y == null) return { x, y };
    // В collapsed-режиме тело окна скрыто, реальная высота — только
    // шапка. Иначе окно не могло опуститься до низа экрана.
    const effectiveH = (stateRef.current === "collapsed")
      ? COLLAPSED_HEAD_H
      : sz.h;
    const maxX = Math.max(8, window.innerWidth - sz.w - 8);
    const maxY = Math.max(8, window.innerHeight - effectiveH - 8);
    return { x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) };
  }
  function clampToViewport(x, y) {
    return clampToViewportFor(x, y, size);
  }

  function computeInitialPos() {
    const effectiveH = (state === "collapsed") ? COLLAPSED_HEAD_H : size.h;
    return clampToViewport(
      window.innerWidth - size.w - 24,
      window.innerHeight - effectiveH - 24
    );
  }

  const currentPos = pos.x == null || pos.y == null ? computeInitialPos() : pos;
  // posRef заполняется здесь — после объявления currentPos, чтобы не
  // поймать ReferenceError из temporal dead zone.
  posRef.current = currentPos;

  function scheduleRAF(fn) {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      fn();
    });
  }

  const DRAG_THRESHOLD_PX = 4;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    // Кнопки «—»/«×», resize и dropdown — обрабатываются своими
    // onClick/onPointerDown. Mode-pill НЕ исключаем: drag за неё должен
    // работать так же, как за profile-pill. Toggle dropdown делаем в
    // onPointerUp через wasModePill (см. ниже) — это подавляет клик
    // без движения и не мешает drag.
    if (e.target.closest("button.llm-window-btn, .llm-window-resize, "
        + ".llm-window-dropdown")) return;
    e.preventDefault();
    const wasPill = !!e.target.closest(".llm-window-pill");
    // .llm-mode-pill — сама кнопка, не обёртка: клик по пункту
    // dropdown (который тоже внутри .llm-mode-pill-wrap) не должен
    // запускать drag. Но .llm-window-dropdown уже отсечён выше.
    const wasModePill = !!e.target.closest(".llm-mode-pill");
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: currentPos.x,
      originY: currentPos.y,
      pointerId: e.pointerId,
      moved: false,
      wasPill,
      wasModePill,
    };
    e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }
  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    d.moved = true;
    const raw = clampToViewport(d.originX + dx, d.originY + dy);
    scheduleRAF(() => setPos(raw));
  }
  function onPointerUp(e) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (!d.moved) {
      // Клик без движения — открываем/закрываем соответствующий dropdown.
      if (d.wasPill) setPillOpen((v) => !v);
      else if (d.wasModePill) setModePillOpen((v) => !v);
      return;
    }
    // Snap-to-edge: если окно близко к краю — прилипаем.
    const snapped = snapToEdges(currentPos);
    setPos(snapped);
    persist(state, snapped, size);
  }

  function snapToEdges(p) {
    if (p.x == null || p.y == null) return p;
    let x = p.x, y = p.y;
    const effectiveH = (state === "collapsed") ? COLLAPSED_HEAD_H : size.h;
    const maxX = window.innerWidth - size.w - 8;
    const maxY = window.innerHeight - effectiveH - 8;
    if (Math.abs(x - 8) <= SNAP_PX) x = 8;
    if (Math.abs(x - maxX) <= SNAP_PX) x = maxX;
    if (Math.abs(y - 8) <= SNAP_PX) y = 8;
    if (Math.abs(y - maxY) <= SNAP_PX) y = maxY;
    return { x, y };
  }

  function onResizePointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originW: size.w,
      originH: size.h,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }
  function onResizePointerMove(e) {
    if (!resizeRef.current) return;
    const dx = e.clientX - resizeRef.current.startX;
    const dy = e.clientY - resizeRef.current.startY;
    const maxW = Math.max(MIN_W, window.innerWidth - currentPos.x - 8);
    const maxH = Math.max(MIN_H, window.innerHeight - currentPos.y - 8);
    const w = Math.max(MIN_W, Math.min(resizeRef.current.originW + dx, maxW));
    const h = Math.max(MIN_H, Math.min(resizeRef.current.originH + dy, maxH));
    scheduleRAF(() => setSize({ w, h }));
  }
  function onResizePointerUp(e) {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    persist(state, currentPos, size);
  }

  function openWindow() {
    let next = pos;
    if (pos.x == null || pos.y == null) next = computeInitialPos();
    setPos(next);
    setState("open");
    persist("open", next, size);
  }
  function collapseWindow() {
    // После свёртывания окно становится низким — если было прижато
    // к низу, его Y мог оказаться «слишком высоким» для нового
    // клампинга. Пересчитываем по эффективной высоте collapsed.
    setState("collapsed");
    const nextPos = clampToViewportForWithH(currentPos.x, currentPos.y,
                                            size, COLLAPSED_HEAD_H);
    setPos(nextPos);
    persist("collapsed", nextPos, size);
  }
  function expandWindow() {
    setState("open");
    const nextPos = clampToViewportForWithH(currentPos.x, currentPos.y,
                                            size, size.h);
    setPos(nextPos);
    persist("open", nextPos, size);
  }
  function closeWindow() { setState("hidden"); persist("hidden", currentPos, size); }

  async function onProfileChange(pid) {
    try {
      await api("/api/v1/llm/profiles/" + pid + "/activate", { method: "POST", body: "{}" });
      setActiveId(pid);
      const found = profiles.find((x) => x.id === pid);
      setProfileName(found ? found.name : "");
    } catch (ex) {
      alert(ex.message);
    }
  }

  function onInputKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function replaceLastAssistant(mutate) {
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        copy[copy.length - 1] = mutate(last);
      }
      return copy;
    });
  }

  // Дренируем буфер стрима кадр за кадром. Вызывается через rAF,
  // сам себя перезапускает пока в буфере есть текст или сервер не закрыл
  // поток. Когда очередь пуста И поток закрыт — финализирует сообщение
  // (снимает streaming-флаг).
  function pumpStreamFrame() {
    streamRafRef.current = null;
    const q = streamBufRef.current;
    if (q) {
      const take = llmSmoothEnabled()
        ? Math.max(2, Math.min(SMOOTH_MAX_PER_FRAME, Math.ceil(q.length / SMOOTH_DRAIN_FRAMES)))
        : q.length;
      const piece = q.slice(0, take);
      streamBufRef.current = q.slice(take);
      replaceLastAssistant((last) => ({ ...last, content: last.content + piece }));
    }
    if (streamBufRef.current || !streamDoneRef.current) {
      streamRafRef.current = requestAnimationFrame(pumpStreamFrame);
      return;
    }
    // Очередь пуста + поток закрыт: финализируем сообщение.
    replaceLastAssistant((last) => ({
      role: "assistant",
      content: last.content || "(пустой ответ)",
      ...(last._mode ? { _mode: last._mode } : {}),
    }));
  }

  function kickStreamPump() {
    if (streamRafRef.current == null) {
      streamRafRef.current = requestAnimationFrame(pumpStreamFrame);
    }
  }

  function resetStreamQueue() {
    if (streamRafRef.current != null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    streamBufRef.current = "";
    streamDoneRef.current = false;
  }

  // ---- Suggest-стрим: буфер, очередь, rAF-pump ----
  //
  // Отличие от чата: сервер шлёт не только текст (chunk), но и структурные
  // события block/final/error. Текст дренится через rAF для плавности,
  // структурные события обрабатываются только когда буфер опустел —
  // тогда блок кода появляется после достримленного explanation, а
  // финал (кнопки, suggested_*) — уже после блока.

  function resetSuggestQueue() {
    if (suggestRafRef.current != null) {
      cancelAnimationFrame(suggestRafRef.current);
      suggestRafRef.current = null;
    }
    suggestBufRef.current = "";
    suggestQueueRef.current = [];
    suggestStreamEndRef.current = false;
    suggestApplyFinalRef.current = null;
  }

  function suggestBlockToAttachment(content, lang) {
    const name = (typeof lang === "string" && lang.trim()) ? lang.trim() : "code";
    return { name, content };
  }

  function applySuggestQueue() {
    const queue = suggestQueueRef.current;
    while (queue.length) {
      const ev = queue[0];
      if (ev.kind === "block") {
        const att = suggestBlockToAttachment(ev.content, ev.lang);
        replaceLastAssistant((last) => ({ ...last, attachment: att }));
        queue.shift();
      } else if (ev.kind === "final") {
        const applyFinal = suggestApplyFinalRef.current;
        if (applyFinal) {
          try {
            const built = applyFinal(ev.fields);
            replaceLastAssistant((last) => {
              // Если стрим уже отрисовал ровно тот же текст (с точностью
              // до хвостовых \n) — оставляем content как есть. Иначе пузырь
              // визуально «сжимается» в момент финала: trailing \n\n
              // пропадают, потому что билдер применяет .trim().
              const streamedTrim = (last.content || "").trimEnd();
              const finalTrim = (built.content || "").trimEnd();
              const sameContent = streamedTrim === finalTrim;
              const next = {
                role: "assistant",
                streaming: false,
                content: sameContent ? last.content : built.content,
              };
              // Переносим _mode от placeholder — по нему собирается history
              // для следующих запросов в этом же режиме (см.
              // buildSuggestHistory). Без этого контекст разорвётся: финал
              // потеряет режим, и LLM снова задаст УТОЧНИТЕ.
              if (last._mode) next._mode = last._mode;
              // Переносим только те поля, что реально есть.
              if (built.attachment) next.attachment = built.attachment;
              if (built.suggested_op) next.suggested_op = built.suggested_op;
              if (built.suggested_alert_rules) next.suggested_alert_rules = built.suggested_alert_rules;
              if (built.suggested_reaction) next.suggested_reaction = built.suggested_reaction;
              if (typeof built.suggested_alert_id === "number") next.suggested_alert_id = built.suggested_alert_id;
              if (typeof built.suggested_rule_id === "number") next.suggested_rule_id = built.suggested_rule_id;
              if (built.suggested_rule_patch) next.suggested_rule_patch = built.suggested_rule_patch;
              return next;
            });
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            replaceLastAssistant(() => ({
              role: "assistant",
              content: "⚠ Не удалось обработать ответ: " + msg,
            }));
          }
        } else {
          replaceLastAssistant((last) => ({ ...last, streaming: false }));
        }
        queue.shift();
        return;
      } else if (ev.kind === "error") {
        replaceLastAssistant((last) => ({
          role: "assistant",
          content: "⚠ " + (ev.code || "E_LLM") + ": " + (ev.message || ""),
          ...(last && last._mode ? { _mode: last._mode } : {}),
        }));
        queue.length = 0;
        return;
      } else {
        queue.shift();
      }
    }
  }

  function pumpSuggestFrame() {
    suggestRafRef.current = null;
    const q = suggestBufRef.current;
    if (q) {
      const take = suggestSmoothEnabled()
        ? Math.max(2, Math.min(SMOOTH_MAX_PER_FRAME, Math.ceil(q.length / SMOOTH_DRAIN_FRAMES)))
        : q.length;
      const piece = q.slice(0, take);
      suggestBufRef.current = q.slice(take);
      replaceLastAssistant((last) => ({ ...last, content: (last.content || "") + piece }));
    }
    if (!suggestBufRef.current) {
      applySuggestQueue();
    }
    if (suggestBufRef.current || suggestQueueRef.current.length) {
      suggestRafRef.current = requestAnimationFrame(pumpSuggestFrame);
    }
  }

  function kickSuggestPump() {
    if (suggestRafRef.current == null) {
      suggestRafRef.current = requestAnimationFrame(pumpSuggestFrame);
    }
  }

  function handleSuggestEvent(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "chunk" && typeof obj.text === "string") {
      suggestBufRef.current += obj.text;
      kickSuggestPump();
    } else if (obj.type === "block") {
      suggestQueueRef.current.push({
        kind: "block",
        content: typeof obj.content === "string" ? obj.content : "",
        lang: obj.lang,
      });
      kickSuggestPump();
    } else if (obj.type === "final") {
      suggestQueueRef.current.push({ kind: "final", fields: obj });
      kickSuggestPump();
    } else if (obj.type === "error") {
      suggestQueueRef.current.push({
        kind: "error", code: obj.code, message: obj.message,
      });
      kickSuggestPump();
    }
  }

  // Настройка плавности. Общая для suggest и обычного чата: ключ
  // melecho.llmSmooth.v1, читается на каждом вызове (см. llmSmoothEnabled).
  function suggestSmoothEnabled() {
    return llmSmoothEnabled();
  }

  // ---- Suggest: SSE-consumer ----
  //
  // Единая точка вызова /llm/suggest-*. Рисует userMsg + placeholder,
  // читает SSE, дёргает handleSuggestEvent. applyFinal(fields) вызывается
  // ровно один раз при final-событии — он превращает структурный ответ
  // в { content, attachment, suggested_* } финального сообщения.
  async function suggestStream(modeLabel, endpoint, placeholderText, body, applyFinal, userContentOverride) {
    if (streaming) return;
    resetSuggestQueue();
    resetStreamQueue();     // на всякий случай: не должно быть активного чата
    const userContent = userContentOverride || ("/" + modeLabel + " " + (body.description || ""));
    // _mode на обоих сообщениях — по нему собирается history для следующих
    // вызовов в этом же режиме (см. buildSuggestHistory).
    const userMsg = { role: "user", content: userContent, _mode: modeLabel };
    const placeholder = { role: "assistant", content: placeholderText, streaming: true, _mode: modeLabel };
    setMessages((prev) => [...prev, userMsg, placeholder]);
    setInput("");
    setStreaming(true);

    suggestApplyFinalRef.current = applyFinal;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": sessionToken,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!r.ok) {
        const data = await r.json().catch(() => null);
        const code = (data && data.error && data.error.code) || ("E_HTTP_" + r.status);
        const msg = (data && data.error && data.error.message) || r.statusText || ("HTTP " + r.status);
        throw { code, message: msg };
      }

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let streamErr = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let obj;
            try { obj = JSON.parse(payload); } catch { continue; }
            handleSuggestEvent(obj);
            if (obj.type === "error") streamErr = { code: obj.code, message: obj.message };
          }
        }
        if (streamErr) break;
      }

      if (streamErr) throw streamErr;

      suggestStreamEndRef.current = true;
      kickSuggestPump();
      // Ждём пока pump дренит буфер и применит final (или error).
      await new Promise((resolve) => {
        const check = () => {
          if (suggestBufRef.current === ""
              && suggestQueueRef.current.length === 0
              && suggestRafRef.current == null) {
            resolve();
          } else {
            setTimeout(check, 16);
          }
        };
        check();
      });
    } catch (ex) {
      resetSuggestQueue();
      const code = (ex && ex.code) || (ex && ex.name) || "E_UNKNOWN";
      if (ex && ex.name === "AbortError") {
        replaceLastAssistant((last) => ({
          role: "assistant",
          content: (last.content || "") + (last.content ? "\n\n" : "") + "_Отменено._",
          ...(last && last._mode ? { _mode: last._mode } : {}),
        }));
      } else {
        const msg = (ex && ex.message) || String(ex);
        replaceLastAssistant(() => ({
          role: "assistant",
          content: "⚠ " + code + ": " + msg,
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      suggestApplyFinalRef.current = null;
    }
  }

  async function sendAlertCommand(description) {
    if (!description) return;
    const history = buildSuggestHistory(messages, "alert");
    const body = { description };
    if (history.length) body.history = history;
    return suggestStream(
      "alert",
      "/api/v1/llm/suggest-alert-rule",
      "Готовлю правила…",
      body,
      (r) => {
        const valid = Array.isArray(r.valid_rules) ? r.valid_rules : [];
        const invalid = Array.isArray(r.invalid_rules) ? r.invalid_rules : [];
        let content = (r.explanation || "").trim();
        const lower = content.toLowerCase();
        const needsClarification = lower.startsWith("уточните:");
        const impossible = lower.startsWith("невозможно:");
        if (r.error && !needsClarification && !impossible) {
          content = content ? content + "\n\n" + r.error : r.error;
          if (r.raw_response) {
            content += "\n\nЧто вернула модель (для диагностики):\n"
              + r.raw_response.slice(0, 1000);
          }
        }
        if (!content && !valid.length && !invalid.length) {
          content = "Модель не вернула правил.";
        }
        if (invalid.length) {
          const lines = invalid.map((x) => "  #" + x.index + ": " + x.error);
          content += (content ? "\n\n" : "") + "Отклонены:\n" + lines.join("\n");
        }
        const attachment = valid.length
          ? { name: "alert-rules: " + valid.length, content: JSON.stringify(valid, null, 2) }
          : null;
        const suggested = (valid.length && !needsClarification && !impossible) ? valid : null;
        return { content, attachment, suggested_alert_rules: suggested };
      },
    );
  }

  async function sendReactionCommand(description) {
    if (!description) return;
    const history = buildSuggestHistory(messages, "reaction");
    const body = { description };
    if (history.length) body.history = history;
    return suggestStream(
      "reaction",
      "/api/v1/llm/suggest-reaction-rule",
      "Готовлю реакцию…",
      body,
      (r) => {
        const valid = r.valid_rule || null;
        let content = (r.explanation || "").trim();
        const lower = content.toLowerCase();
        const needsClarification = lower.startsWith("уточните:");
        const impossible = lower.startsWith("невозможно:");
        if (r.error && !needsClarification && !impossible) {
          content = content ? content + "\n\n" + r.error : r.error;
          if (r.raw_response) {
            content += "\n\nЧто вернула модель (для диагностики):\n"
              + r.raw_response.slice(0, 1000);
          }
        }
        if (!content && !valid) {
          content = "Модель не вернула правила реакции.";
        }
        const attachment = valid
          ? { name: "reaction: " + (valid.name || "rule"), content: JSON.stringify(valid, null, 2) }
          : null;
        const suggested = (valid && !needsClarification && !impossible) ? valid : null;
        return { content, attachment, suggested_reaction: suggested };
      },
    );
  }

  // Одноразовое объяснение конкретного алерта. НЕ sticky, не меняет режим.
  // Пользователь пишет "/explain 42 почему упало?" — открывается контекст
  // алерта, LLM отвечает текстом (без JSON/YAML). Под ответом появляется
  // кнопка «Открыть алерт #N» для перехода к модалке.
  async function sendExplainCommand(alertId, question, attach) {
    if (!alertId || streaming) return;
    resetStreamQueue();
    const q = (question || "").trim();
    // Два источника:
    //   - явный /explain N вопрос → userMsg с префиксом, без вложения
    //   - экспорт алерта (↗) + текст → userMsg обычный, attachment виден
    // Обработка одинаковая: POST /llm/explain-alert.
    const userMsg = attach
      ? { role: "user", content: q, attachment: attach }
      : { role: "user", content: "/explain " + alertId + (q ? " " + q : "") };
    const placeholder = { role: "assistant", content: "Готовлю объяснение…", streaming: true };
    setMessages((prev) => [...prev, userMsg, placeholder]);
    setInput("");
    setAttachment(null);   // attachment израсходован
    setStreaming(true);
    try {
      const r = await api("/api/v1/llm/explain-alert", {
        method: "POST",
        body: JSON.stringify({ alert_id: alertId, question: q }),
      });
      const assistantMsg = {
        role: "assistant",
        content: (r.explanation || "").trim() || "(пустое объяснение)",
        streaming: false,
        suggested_alert_id: r.alert_id,
      };
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = assistantMsg;
        return copy;
      });
    } catch (ex) {
      const code = (ex && ex.code) || "E_LLM";
      const msg = (ex && ex.message) || String(ex);
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: "⚠ " + code + ": " + msg,
        };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  // /explain-rule <id> [вопрос] — одноразовое объяснение правила
  // алерта. Не sticky, режим чата не меняет.
  async function sendExplainRuleCommand(ruleId, question) {
    if (!ruleId || streaming) return;
    resetStreamQueue();
    const q = (question || "").trim();
    const userMsg = { role: "user", content: "/explain-rule " + ruleId + (q ? " " + q : "") };
    const placeholder = { role: "assistant", content: "Готовлю объяснение…", streaming: true };
    setMessages((prev) => [...prev, userMsg, placeholder]);
    setInput("");
    setStreaming(true);
    try {
      const r = await api("/api/v1/llm/explain-rule", {
        method: "POST",
        body: JSON.stringify({ rule_id: ruleId, question: q }),
      });
      const assistantMsg = {
        role: "assistant",
        content: (r.explanation || "").trim() || "(пустое объяснение)",
        streaming: false,
        suggested_rule_id: r.rule_id,
      };
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = assistantMsg;
        return copy;
      });
    } catch (ex) {
      const code = (ex && ex.code) || "E_LLM";
      const msg = (ex && ex.message) || String(ex);
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: "⚠ " + code + ": " + msg,
        };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  // /edit-rule <id> <описание> — LLM предлагает patch для правила.
  // Под ответом появится кнопка «Применить правку» — откроет
  // AlertRuleEditor с предзаполнением (данные patch мержатся на текущее
  // правило клиентом, backend уже отвалидировал патч).
  async function sendEditRuleCommand(ruleId, description) {
    if (!ruleId) return;
    const desc = (description || "").trim();
    if (!desc) {
      setMessages((prev) => [...prev,
        { role: "user", content: "/edit-rule " + ruleId },
        { role: "assistant",
          content: "Укажите описание правки: /edit-rule <id> <что изменить>" },
      ]);
      setInput("");
      return;
    }
    const history = buildSuggestHistory(messages, "edit-rule");
    const body = { rule_id: ruleId, description: desc };
    if (history.length) body.history = history;
    return suggestStream(
      "edit-rule",
      "/api/v1/llm/suggest-rule-edit",
      "Готовлю правку…",
      body,
      (r) => {
        let content = (r.explanation || "").trim();
        const lower = content.toLowerCase();
        const needsClarification = lower.startsWith("уточните:");
        const impossible = lower.startsWith("невозможно:");
        if (r.error && !needsClarification && !impossible) {
          content = content ? content + "\n\n" + r.error : r.error;
          if (r.raw_response) {
            content += "\n\nЧто вернула модель (для диагностики):\n"
              + r.raw_response.slice(0, 1000);
          }
        }
        if (!content && !r.patch) {
          content = "Модель не вернула изменений.";
        }
        const suggestion = (r.patch && !needsClarification && !impossible)
          ? { rule_id: r.rule_id, patch: r.patch }
          : null;
        return {
          content,
          suggested_rule_id: r.rule_id,
          suggested_rule_patch: suggestion,
        };
      },
      "/edit-rule " + ruleId + " " + desc,
    );
  }

  async function sendOperationCommand(description) {
    if (!description) return;
    const history = buildSuggestHistory(messages, "operation");
    const body = { description };
    if (history.length) body.history = history;
    return suggestStream(
      "operation",
      "/api/v1/llm/suggest-operation",
      "Готовлю YAML…",
      body,
      (r) => {
        const attachment = r.yaml
          ? { name: "yaml: " + (r.id || "operation"), content: r.yaml }
          : null;
        // Разбор ответа по особым случаям:
        //   - explanation начинается с "УТОЧНИТЕ:" → модель задаёт вопрос
        //   - explanation начинается с "НЕВОЗМОЖНО:" → модели нужна
        //     команда вне списка
        //   - explanation это маркер "[модель израсходовала...]" → модель
        //     ушла в reasoning и не вернулась
        //   - всё пусто → реальная ошибка, показываем сырой ответ
        let content = (r.explanation || "").trim();
        const lower = content.toLowerCase();
        const needsClarification = lower.startsWith("уточните:");
        const impossible = lower.startsWith("невозможно:");
        const reasoningOnly = content.includes("израсходовала весь лимит токенов");
        if (!content && !r.yaml) {
          content = "Модель не вернула ни объяснения, ни YAML. "
            + (r.error ? ("Причина: " + r.error) : "Попробуйте переформулировать запрос.");
        }
        if ((reasoningOnly || (!content && !r.yaml)) && r.raw_response) {
          content += "\n\nЧто вернула модель (для диагностики):\n"
            + r.raw_response.slice(0, 1200);
        }
        // Кнопка «В редактор» только когда YAML валиден. В случаях
        // УТОЧНИТЕ/НЕВОЗМОЖНО YAML и не должно быть.
        const suggestedOp = (r.yaml && r.valid && !needsClarification && !impossible)
          ? { yaml: r.yaml, id: r.id } : null;
        if (!content && r.yaml && !r.valid) {
          content = "YAML не прошёл валидацию: " + (r.error || "—");
        }
        return { content, attachment, suggested_op: suggestedOp };
      },
    );
  }

  async function sendMessage() {
    const text = input.trim();
    // Явный /operation <описание> — переключает режим и отправляет.
    // /operation без текста — только переключение, поле очищается,
    // пользователь пишет описание следующим сообщением.
    // /help — локальная справка, без LLM.
    if (text === "/help") {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: "/help" },
        { role: "assistant", content: LLM_HELP_TEXT },
      ]);
      setInput("");
      return;
    }

    // /explain-rule <id> [вопрос] — объяснение правила.
    // ВАЖНО: проверяем ДО /explain, потому что "/explain-rule"
    // начинается с "/explain " (после слэша). Порядок важен.
    if (text === "/explain-rule" || text.startsWith("/explain-rule ")) {
      const rest = text.slice("/explain-rule".length).trim();
      const m = /^(\d+)(?:\s+([\s\S]+))?$/.exec(rest);
      if (!m) {
        setMessages((prev) => [...prev,
          { role: "user", content: text },
          { role: "assistant",
            content: "Укажите id правила: /explain-rule <id> [вопрос]" },
        ]);
        setInput("");
        return;
      }
      const rid = Number(m[1]);
      const q = (m[2] || "").trim();
      return sendExplainRuleCommand(rid, q);
    }

    // /edit-rule <id> <описание> — LLM предложит patch.
    // Проверяем тоже ДО /explain.
    if (text === "/edit-rule" || text.startsWith("/edit-rule ")) {
      const rest = text.slice("/edit-rule".length).trim();
      const m = /^(\d+)(?:\s+([\s\S]+))?$/.exec(rest);
      if (!m) {
        setMessages((prev) => [...prev,
          { role: "user", content: text },
          { role: "assistant",
            content: "Укажите id правила и описание: /edit-rule <id> <что изменить>" },
        ]);
        setInput("");
        return;
      }
      const rid = Number(m[1]);
      const desc = (m[2] || "").trim();
      return sendEditRuleCommand(rid, desc);
    }

    // /explain <id> [вопрос] — одноразовое объяснение конкретного алерта.
    // НЕ переключает режим чата (не sticky). Отдельная команда, отдельный
    // endpoint, отдельный промпт. Работает из любого режима.
    if (text === "/explain" || text.startsWith("/explain ")) {
      const rest = text.slice("/explain".length).trim();
      const m = /^(\d+)(?:\s+([\s\S]+))?$/.exec(rest);
      if (!m) {
        // id не указан или не число — подсказка, ничего не шлём.
        setMessages((prev) => [...prev,
          { role: "user", content: text },
          { role: "assistant",
            content: "Укажите id алерта: /explain <id> [вопрос]" },
        ]);
        setInput("");
        return;
      }
      const aid = Number(m[1]);
      const q = (m[2] || "").trim();
      return sendExplainCommand(aid, q);
    }

    // Если во вложении есть alert_id — работаем как /explain: тот же
    // endpoint, тот же промпт, тот же формат ответа. Это унифицирует
    // «/explain 1 вопрос» и «экспорт алерта + вопрос» — поведение
    // одинаковое, отличается только способ передать контекст.
    if (attachment && typeof attachment.alert_id === "number") {
      return sendExplainCommand(attachment.alert_id, text, attachment);
    }

    // Явные префиксы режимов: /operation, /alert, /reaction.
    const MODE_PREFIXES = ["operation", "alert", "reaction"];
    for (const m of MODE_PREFIXES) {
      const pfx = "/" + m;
      if (text === pfx || text.startsWith(pfx + " ")) {
        const desc = text.slice(pfx.length).trim();
        setChatMode(m);
        if (!desc) {
          setInput("");
          return;
        }
        if (m === "operation") return sendOperationCommand(desc);
        if (m === "alert")     return sendAlertCommand(desc);
        if (m === "reaction")  return sendReactionCommand(desc);
      }
    }
    // sticky-режим: каждое сообщение в operation идёт в suggest.
    // Пустое поле — не отправляем. Вложение игнорируется: suggest
    // принимает только текст-описание.
    if (chatMode !== "chat") {
      if (!text) return;
      if (chatMode === "operation") return sendOperationCommand(text);
      if (chatMode === "alert")     return sendAlertCommand(text);
      if (chatMode === "reaction")  return sendReactionCommand(text);
    }
    const attach = attachment;  // снапшот; ниже очистим
    // Отправляем, если есть хоть что-то: текст или вложение.
    if ((!text && !attach) || streaming) return;

    // Для LLM собираем плоский content: если у сообщения было вложение —
    // разворачиваем его в маркированный блок. Так LLM видит содержимое
    // независимо от того, читается история из LS или с текущего состояния.
    const expand = (m) => {
      let c = m.content || "";
      if (m.attachment) {
        c = "[вложение: " + m.attachment.name + "]\n\n"
          + m.attachment.content
          + (c ? "\n\n" + c : "");
      }
      return c;
    };
    // История для /llm/chat: только сообщения режима chat.
    //
    // Без фильтра в chat-запрос попадали reaction/alert/operation-сообщения
    // — LLM видела предыдущий ответ как JSON-правило и продолжала его
    // в том же формате, игнорируя роль chat-ассистента. Разные режимы —
    // разные контексты.
    //
    // Сообщения БЕЗ _mode — это старые записи (до введения поля);
    // в доктрине «сначала был только chat» считаем их chat-контекстом.
    const history = messages
      .filter((m) => !m.streaming && (m.content || m.attachment) && !m.blocked
                     && (!m._mode || m._mode === "chat"))
      .map((m) => ({ role: m.role, content: expand(m) }));
    // System-сообщение НЕ шлём — backend подставит свежий
    // (build_chat_system_prompt с актуальным whitelist).
    const outgoing = [
      ...history,
      { role: "user", content: expand({ content: text, attachment: attach }) },
    ];

    const userMsg = { role: "user", content: text, _mode: "chat" };
    if (attach) userMsg.attachment = attach;
    const placeholder = { role: "assistant", content: '', streaming: true, _mode: "chat" };
    resetStreamQueue();
    setMessages((prev) => [...prev, userMsg, placeholder]);
    setInput('');
    setAttachment(null);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch("/api/v1/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": sessionToken,
        },
        // 4000 токенов: chat-режим — короткие ответы, но reasoning-модели
        // (Gemma, Gemini 2.x) тратят бюджет на внутренние рассуждения
        // до появления видимого контента. 600 не хватало — ответ
        // обрезался или приходил пустым.
        body: JSON.stringify({ messages: outgoing, max_tokens: 4000 }),
        signal: ctrl.signal,
      });

      if (!r.ok) {
        // Валидация тела (пустой messages и т.п.) возвращает JSON-ошибку 400.
        const data = await r.json().catch(() => null);
        const code = (data && data.error && data.error.code) || "E_HTTP_" + r.status;
        const msg = (data && data.error && data.error.message) || r.statusText || ("HTTP " + r.status);
        throw { code, message: msg };
      }

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sseError = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          if (!ev.startsWith("data:")) continue;
          const payload = ev.slice(5).trim();
          if (!payload) continue;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (obj.type === "chunk" && typeof obj.text === "string") {
            // Не рисуем сразу: копим в буфер, pump отрендерит постепенно.
            // Это сглаживает случай, когда reasoning-модель присылает
            // весь видимый ответ одним куском после <thought>.
            streamBufRef.current += obj.text;
            kickStreamPump();
          } else if (obj.type === "error") {
            sseError = { code: obj.code || "E_LLM", message: obj.message || "ошибка стрима" };
            break;
          }
        }
        if (sseError) break;
      }

      if (sseError) throw sseError;

      // Поток закрыт: помечаем done и ждём, пока pump доедет очередь.
      // Финализацию сообщения (снятие streaming-флага) делает pump —
      // иначе finally снимет setStreaming раньше, чем текст дорисуется.
      streamDoneRef.current = true;
      kickStreamPump();
      await new Promise((resolve) => {
        const check = () => {
          if (streamBufRef.current === "" && streamRafRef.current == null) resolve();
          else setTimeout(check, 16);
        };
        check();
      });
    } catch (ex) {
      // На ошибке/отмене не даём хвосту доехать — иначе отложенный
      // текст наложится на сообщение об ошибке.
      resetStreamQueue();
      const code = (ex && ex.code) || (ex && ex.name) || "E_UNKNOWN";
      if (ex && ex.name === "AbortError") {
        replaceLastAssistant((last) => ({
          role: "assistant",
          content: (last.content || "") + (last.content ? "\n\n" : "") + "_Отменено._",
          ...(last && last._mode ? { _mode: last._mode } : {}),
        }));
      } else {
        const msg = (ex && ex.message) || String(ex);
        replaceLastAssistant((last) => ({
          role: "assistant",
          content: "⚠ " + code + ": " + msg,
          ...(last && last._mode ? { _mode: last._mode } : {}),
        }));
        // S4: сообщение, вызвавшее срабатывание канарейки, из истории убираем —
        // иначе оно будет валиться при каждой следующей отправке.
        if (code === "E_LLM_CANARY") {
          setMessages((prev) => {
            const copy = prev.slice();
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "user" && !copy[i].blocked) {
                copy[i] = { ...copy[i], blocked: true };
                break;
              }
            }
            return copy;
          });
        }
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function cancelStream() {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
    }
  }

  function requestClearChat() { setConfirmClearOpen(true); }
  function clearChat() {
    setMessages([]);
    setChatMode("chat");
    setConfirmClearOpen(false);
  }

  if (state === "hidden") {
    return html`<button class="llm-window-fab" title="Открыть окно LLM" onClick=${openWindow}>LLM</button>`;
  }

  const cls = "llm-window " + (state === "collapsed" ? "collapsed" : "") + (dragging ? " dragging" : "");
  const style = `left: ${currentPos.x}px; top: ${currentPos.y}px; width: ${size.w}px;` +
    (state === "open" ? ` height: ${size.h}px;` : "");

  return html`<div class=${cls} style=${style}>
    <div class="llm-window-head"
         onPointerDown=${onPointerDown}
         onPointerMove=${onPointerMove}
         onPointerUp=${onPointerUp}
         onPointerCancel=${onPointerUp}>
      <button type="button"
              class=${"llm-window-pill " + (pillOpen ? "open" : "")}
              title="Профиль LLM — клик для выбора, drag для перемещения окна">
        <span class="llm-window-pill-label">LLM</span>
        <span class="llm-window-pill-sep">·</span>
        <span class="llm-window-pill-text">${profileName || "профиль не задан"}</span>
        ${profiles.length > 0
          ? html`<span class="llm-window-pill-arrow" aria-hidden="true">▾</span>`
          : null}
      </button>
      <${ModePill}
          value=${chatMode}
          onChange=${setChatMode}
          open=${modePillOpen}
          setOpen=${setModePillOpen} />
      <div class="grow"></div>
      <button class="llm-window-btn"
              title=${state === "open" ? "Свернуть" : "Развернуть"}
              onClick=${state === "open" ? collapseWindow : expandWindow}>
        ${state === "open" ? "—" : "+"}
      </button>
      <button class="llm-window-btn" title="Закрыть" onClick=${closeWindow}>×</button>
      ${pillOpen && profiles.length > 0
        ? html`<div class="llm-window-dropdown">
            ${profiles.map((p) => html`<button type="button"
                class=${p.id === activeId ? "active" : ""}
                onClick=${() => { setPillOpen(false); if (p.id !== activeId) onProfileChange(p.id); }}>
              ${p.name} <span class="muted small">· ${p.provider}</span>
            </button>`)}
          </div>`
        : null}
    </div>
    ${state === "open"
      ? html`<div class="llm-window-body">
          <div class="llm-chat" ref=${chatBoxRef}>
            ${messages.length === 0
              ? html`<div class="llm-chat-empty">
                  Напишите сообщение, чтобы начать.
                  <br/><span class="mono">/help</span> — список команд
                </div>`
              : messages.map((m, i) => {
                  const actions = [];
                  if (m.suggested_op) {
                    actions.push(html`<button type="button" key="op" class="llm-open-editor-btn"
                        onClick=${() => openUserOpEditorFromChat(m.suggested_op.yaml)}>
                      В редактор
                    </button>`);
                  }
                  if (m.suggested_alert_rules && m.suggested_alert_rules.length) {
                    actions.push(html`<button type="button" key="ar" class="llm-open-editor-btn"
                        onClick=${() => window.dispatchEvent(new CustomEvent(
                          "melecho:llm-create-alert-rules",
                          { detail: { rules: m.suggested_alert_rules } }))}>
                      Создать (${m.suggested_alert_rules.length})
                    </button>`);
                  }
                  if (m.suggested_reaction) {
                    actions.push(html`<button type="button" key="rx" class="llm-open-editor-btn"
                        onClick=${() => window.dispatchEvent(new CustomEvent(
                          "melecho:llm-create-reaction",
                          { detail: { rule: m.suggested_reaction } }))}>
                      В реакциях
                    </button>`);
                  }
                  if (typeof m.suggested_alert_id === "number") {
                    actions.push(html`<button type="button" key="aid" class="llm-open-editor-btn"
                        onClick=${() => window.dispatchEvent(new CustomEvent(
                          "melecho:llm-open-alert",
                          { detail: { alert_id: m.suggested_alert_id } }))}>
                      Алерт #${m.suggested_alert_id}
                    </button>`);
                  }
                  if (typeof m.suggested_rule_id === "number") {
                    actions.push(html`<button type="button" key="rid" class="llm-open-editor-btn"
                        onClick=${() => window.dispatchEvent(new CustomEvent(
                          "melecho:llm-open-rule",
                          { detail: { rule_id: m.suggested_rule_id } }))}>
                      Правило #${m.suggested_rule_id}
                    </button>`);
                  }
                  if (m.suggested_rule_patch) {
                    actions.push(html`<button type="button" key="patch" class="llm-open-editor-btn"
                        onClick=${() => window.dispatchEvent(new CustomEvent(
                          "melecho:llm-apply-rule-patch",
                          { detail: m.suggested_rule_patch }))}>
                      Применить
                    </button>`);
                  }
                  return html`<div key=${i} class=${"llm-msg-block " + m.role}>
                    <div class=${"llm-msg " + m.role
                        + (m.streaming ? " streaming" : "")
                        + (m.blocked ? " blocked" : "")}
                        title=${m.blocked ? "Сообщение не отправлено: сработала защита от утечки секретов" : ""}>
                      <div class=${"llm-reveal" + (m.attachment ? " shown" : "")}>
                        <div class="llm-reveal-inner">
                          ${m.attachment
                            ? html`<details class="llm-attach-inline">
                                <summary>${m.attachment.name}</summary>
                                <pre class="llm-attach-pre">${m.attachment.content}</pre>
                              </details>`
                            : null}
                        </div>
                      </div>
                      ${m.blocked ? "🚫 " : ""}${(m.content || "").replace(/\n+$/, "") || (m.streaming ? "" : (m.attachment ? "" : "…"))}
                    </div>
                    <div class=${"llm-reveal" + (actions.length ? " shown" : "")}>
                      <div class="llm-reveal-inner">
                        ${actions.length
                          ? html`<div class="llm-msg-actions">${actions}</div>`
                          : null}
                      </div>
                    </div>
                  </div>`;
                })}
          </div>
          ${attachNotice
            ? html`<div class="llm-attach-notice">${attachNotice}</div>`
            : null}
          <div class="llm-chat-foot">
            ${attachment
              ? html`<div class="llm-attach-pill">
                  <span class="llm-attach-name" title=${attachment.name}>${attachment.name}</span>
                  <button type="button" class="llm-attach-x"
                          title="Убрать вложение"
                          onClick=${() => setAttachment(null)}>×</button>
                </div>`
              : null}
            ${messages.length > 0
              ? html`<${SymBtn} symbol="↺" tooltip="Очистить историю"
                    onClick=${requestClearChat} />`
              : null}
            <textarea ref=${inputRef}
                      placeholder=${chatModeSpec(chatMode).placeholder}
                      rows="1"
                      value=${input}
                      disabled=${streaming}
                      onInput=${(e) => setInput(e.target.value)}
                      onKeyDown=${onInputKey}></textarea>
            <button type="button" class="llm-chat-expand"
                    title="Открыть большой формат"
                    disabled=${streaming}
                    onClick=${() => setChatOpen(true)}>⤢</button>
            ${streaming
              ? html`<${SymBtn} symbol="■" tooltip="Остановить"
                    onClick=${cancelStream} />`
              : html`<${SymBtn} symbol="➤" tooltip="Отправить"
                    disabled=${!input.trim() && !attachment}
                    send=${true} onClick=${sendMessage} />`}
          </div>
        </div>
        <div class="llm-window-resize"
             onPointerDown=${onResizePointerDown}
             onPointerMove=${onResizePointerMove}
             onPointerUp=${onResizePointerUp}
             onPointerCancel=${onResizePointerUp}></div>`
      : null}
    ${chatOpen
      ? html`<${LLMChatModal}
            messages=${messages}
            input=${input} setInput=${setInput}
            streaming=${streaming} sendMessage=${sendMessage} cancelStream=${cancelStream}
            attachment=${attachment} setAttachment=${setAttachment}
            attachNotice=${attachNotice}
            profileName=${profileName} profiles=${profiles}
            activeId=${activeId} onProfileChange=${onProfileChange}
            chatMode=${chatMode} onChangeMode=${setChatMode}
            onRequestClear=${requestClearChat}
            onClose=${() => setChatOpen(false)} />`
      : null}
    ${confirmClearOpen
      ? html`<${Modal} title="Очистить историю?" onClose=${() => setConfirmClearOpen(false)}
          footer=${html`<div class="row">
            <button class="btn btn-ghost btn-sm" onClick=${() => setConfirmClearOpen(false)}>Отмена</button>
            <button class="btn btn-danger btn-sm" onClick=${clearChat}>Очистить</button>
          </div>`}>
          <p>Все сообщения этого чата будут удалены. Действие необратимо.</p>
        </${Modal}>`
      : null}
  </div>`;
}

function SudoUnlockModal({ onClose, onDone }) {
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("session");
  const [ackDisk, setAckDisk] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);  // null | "checking" | "ok" | "fail"
  const [checkResult, setCheckResult] = useState(null);
  const [canCheck, setCanCheck] = useState(null);        // null = загрузка
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      setTimeout(() => { try { inputRef.current.focus(); } catch {} }, 30);
    }
    // Определяем, есть ли сервер с подтверждённым host key.
    // Если нет — проверка невозможна, разрешаем разблокировать без неё.
    api("/api/v1/servers")
      .then((r) => setCanCheck((r.items || []).some((s) => s.hostkey)))
      .catch(() => setCanCheck(false));
  }, []);

  function onPasswordChange(v) {
    setPassword(v);
    setCheckStatus(null);
    setCheckResult(null);
    setErr("");
  }

  async function check() {
    setCheckStatus("checking");
    setCheckResult(null);
    setErr("");
    try {
      const r = await api("/api/v1/sudo/unlock/check", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        setCheckStatus("ok");
        setCheckResult({ ok: true });
      } else {
        setCheckStatus("fail");
        setCheckResult({ ok: false, code: r.code, message: r.message });
      }
    } catch (ex) {
      setCheckStatus("fail");
      setCheckResult({ ok: false, message: ex.message });
    }
  }

  async function submit() {
    setBusy(true); setErr("");
    try {
      await api("/api/v1/sudo/unlock/provide", {
        method: "POST",
        body: JSON.stringify({ password, mode }),
      });
      onDone && onDone();
    } catch (ex) {
      setErr(ex.message);
    } finally { setBusy(false); }
  }

  const needsAck = mode === "disk";
  const checkPassed = checkStatus === "ok";
  const noServers = canCheck === false;
  const canSubmit =
    !busy
    && !!password
    && (!needsAck || ackDisk)
    && (checkPassed || noServers);

  return html`<${Modal} title="Разблокировать автосудо" onClose=${onClose}
    footer=${html`<div class="row">
      <button class="btn btn-ghost btn-sm" onClick=${onClose}>Отмена</button>
      <button class="btn btn-primary btn-sm" disabled=${!canSubmit} onClick=${submit}>
        ${busy ? "Разблокировка…" : "Разблокировать"}
      </button>
    </div>`}>
    <p class="muted">
      Пароль sudo будет использован для автоматических реакций и операций,
      требующих sudo. Никогда не попадает в аудит, логи или LLM.
    </p>
    <label>Пароль sudo</label>
    <input ref=${inputRef} type="password" autocomplete="off"
           value=${password} onInput=${(e) => onPasswordChange(e.target.value)} />

    ${canCheck === null
      ? null
      : noServers
      ? html`<div class="muted small">
          Нет серверов с подтверждённым host key — проверка недоступна.
          Пароль будет сохранён без проверки.
        </div>`
      : html`<div class="stack">
          <div class="row">
            <button type="button" class="btn btn-sm"
                    disabled=${!password || checkStatus === "checking"}
                    onClick=${check}>
              ${checkStatus === "checking" ? "Проверка…" : "Проверить пароль"}
            </button>
            ${checkPassed ? html`<span class="okt">✓ Пароль принят сервером</span>` : null}
          </div>
          ${checkStatus === "fail" && checkResult
            ? html`<div class="err">✗ ${checkResult.code || ""} ${checkResult.message || ""}</div>`
            : null}
        </div>`}

    <label>Режим хранения</label>
    <select value=${mode} onChange=${(e) => setMode(e.target.value)}>
      <option value="session">До конца сессии (RAM)</option>
      <option value="30m">30 минут (RAM)</option>
      <option value="2h">2 часа (RAM)</option>
      <option value="8h">8 часов (RAM)</option>
      <option value="disk">На диск (зашифрован DEK)</option>
    </select>

    ${needsAck
      ? html`<div class="banner warn">
          <label class="check">
            <input type="checkbox" checked=${ackDisk}
                   onChange=${(e) => setAckDisk(e.target.checked)} />
            Понимаю, что пароль будет сохранён на диск зашифрованным.
            При компрометации машины он может утечь.
          </label>
        </div>`
      : null}

    ${err ? html`<div class="err">${err}</div>` : null}
    ${!checkPassed && !noServers && password
      ? html`<p class="muted small">
          Сначала проверьте пароль — кнопка «Разблокировать» станет доступной после успешной проверки.
        </p>`
      : null}
  </${Modal}>`;
}
function SudoUnlockSection() {
  const [st, setSt] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    try { setSt(await api("/api/v1/sudo/unlock/status")); }
    catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  async function revoke() {
    if (!confirm("Отозвать автосудо? Пароль будет стёрт из памяти и из settings.")) return;
    setBusy(true); setErr("");
    try { setSt(await api("/api/v1/sudo/unlock/revoke", { method: "POST", body: "{}" })); }
    catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  if (!st) return null;

  const modeLabel = {
    none: "не активен",
    session: "до конца сессии (RAM)",
    "30m": "30 минут (RAM)",
    "2h": "2 часа (RAM)",
    "8h": "8 часов (RAM)",
    disk: "на диск (зашифрован)",
  }[st.mode] || st.mode;

  return html`<div class="card stack">
    <h3>Автосудо</h3>
    <p class="muted">
      Пароль sudo для автоматических реакций и операций с sudo.
      RAM-режимы живут в памяти процесса, режим «на диск» переживает рестарт.
    </p>
    <div class="row">
      <span class=${"badge " + (st.valid ? "ok" : "")}>
        ${st.valid ? "активно" : "не активно"}
      </span>
      <span class="muted">режим: ${modeLabel}</span>
      ${st.until ? html`<span class="muted mono">до ${st.until}</span>` : null}
    </div>
    <div class="row">
      ${st.valid
        ? html`<button class="btn btn-sm btn-danger" disabled=${busy} onClick=${revoke}>Отозвать</button>`
        : html`<button class="btn btn-sm btn-primary" onClick=${() => setOpen(true)}>Разблокировать</button>`}
    </div>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${open
      ? html`<${SudoUnlockModal}
            onClose=${() => setOpen(false)}
            onDone=${async () => { setOpen(false); await load(); }} />`
      : null}
  </div>`;
}

function RetentionSection() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({});            // short_key -> строка из input
  const [confirmRun, setConfirmRun] = useState(null); // { plan } | null

  async function load() {
    setErr("");
    try {
      const s = await api("/api/v1/retention/status");
      setStatus(s);
      const d = {};
      for (const r of s.rules) d[r.short_key] = String(r.keep_days);
      setDraft(d);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  function resetDraftFrom(status) {
    const d = {};
    for (const rule of status.rules) d[rule.short_key] = String(rule.keep_days);
    setDraft(d);
  }

  async function saveOne(shortKey) {
    const cur = status.rules.find((r) => r.short_key === shortKey);
    if (!cur) return;
    const raw = draft[shortKey];
    // Пустое поле или невалидный ввод — откатываем и молчим.
    if (raw == null || String(raw).trim() === "") {
      setDraft({ ...draft, [shortKey]: String(cur.keep_days) });
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v !== Math.round(v)) {
      setDraft({ ...draft, [shortKey]: String(cur.keep_days) });
      return;
    }
    if (v === cur.keep_days) return;
    try {
      const r = await api("/api/v1/retention/settings", {
        method: "PATCH",
        body: JSON.stringify({ [shortKey]: v }),
      });
      setStatus(r);
      resetDraftFrom(r);
    } catch (ex) {
      setErr(ex.message);
      setDraft((d) => ({ ...d, [shortKey]: String(cur.keep_days) }));
    }
  }

  async function dryRun() {
    setBusy(true); setErr("");
    try {
      const r = await api("/api/v1/retention/run?dry_run=true", { method: "POST", body: "{}" });
      setConfirmRun({ plan: r.plan });
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function realRun() {
    setBusy(true); setErr("");
    try {
      const r = await api("/api/v1/retention/run?dry_run=false", { method: "POST", body: "{}" });
      const total = (r.deleted || []).reduce(
        (s, x) => s + Math.max(0, x.deleted || 0), 0
      );
      setConfirmRun(null);
      showToast("Очищено строк: " + total, "ok");
      await load();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  if (!status) return html`<div class="card stack">
    <h3>Хранение данных</h3>
    <p class="muted">Загрузка…</p>
  </div>`;

  const planTotal = confirmRun
    ? confirmRun.plan.reduce((s, p) => s + (p.would_delete || 0), 0)
    : 0;

  return html`<div class="card stack">
    <h3>Хранение данных</h3>
    <p class="muted small">
      Срок хранения каждого типа данных. Активные алерты и незавершённые
      реакции не удаляются никогда — только закрытые. Журнал аудита
      (HMAC-chain, S2) не удаляется вообще.
    </p>
    ${err ? html`<div class="err">${err}</div>` : null}

    <div class="table-wrap">
      <table class="retention-table">
        <thead>
          <tr>
            <th>Таблица</th>
            <th>Сейчас</th>
            <th>Срок</th>
            <th>К удалению</th>
          </tr>
        </thead>
        <tbody>
          ${status.rules.map((r) => html`<tr key=${r.key}>
            <td>${r.description}</td>
            <td class="mono">
              ${(r.rows_total || 0).toLocaleString("ru-RU")}
            </td>
            <td>
              <div class="retention-days">
                <input type="number"
                       min=${r.min_days} max=${r.max_days}
                       value=${draft[r.short_key] ?? String(r.keep_days)}
                       disabled=${busy}
                       onInput=${(e) => setDraft({ ...draft, [r.short_key]: e.target.value })}
                       onBlur=${() => saveOne(r.short_key)}
                       onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} />
                ${r.zero_means_never && Number(draft[r.short_key]) === 0
                  ? html`<span class="muted small">никогда</span>`
                  : html`<span class="muted small">дней</span>`}
              </div>
            </td>
            <td class="mono ${r.would_delete > 0 ? "retention-would" : "muted"}">
              ${(r.would_delete || 0).toLocaleString("ru-RU")}
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>

    <div class="row retention-foot">
      <button class="btn btn-sm" disabled=${busy} onClick=${dryRun}>
        Очистить сейчас
      </button>
      <div class="muted small grow retention-foot-info">
        ${status.last_run_at
          ? html`Последняя очистка: <span class="mono">${status.last_run_at}</span>`
          : html`Автоматическая очистка ещё не запускалась`}
        ${status.next_run_at
          ? html` · следующая ≈ <span class="mono">${status.next_run_at}</span>`
          : null}
        · интервал ${Math.round((status.run_interval_sec || 0) / 60)} мин
      </div>
    </div>

    ${confirmRun
      ? html`<${Modal} title="Очистка данных"
          onClose=${() => setConfirmRun(null)}
          footer=${html`<div class="row">
            <button class="btn btn-ghost btn-sm" onClick=${() => setConfirmRun(null)}>Отмена</button>
            <div class="grow"></div>
            <button class="btn btn-danger btn-sm"
                    disabled=${busy || planTotal === 0}
                    onClick=${realRun}>
              ${busy ? "Удаление…" : ("Удалить сейчас (" + planTotal + ")")}
            </button>
          </div>`}>
          <p class="muted">
            Планируется удалить следующие строки. Активные алерты,
            незавершённые реакции и audit_log не затрагиваются.
          </p>
          <table class="no-last-border">
            <thead>
              <tr><th>Таблица</th><th style="text-align:right">К удалению</th></tr>
            </thead>
            <tbody>
              ${confirmRun.plan.map((p) => html`<tr key=${p.key}>
                <td>${p.description}</td>
                <td class="mono" style="text-align:right">
                  ${(p.would_delete || 0).toLocaleString("ru-RU")}
                </td>
              </tr>`)}
              ${planTotal === 0
                ? html`<tr><td colspan="2" class="muted small">
                    Ничего удалять не нужно — все данные в пределах срока хранения
                  </td></tr>`
                : null}
            </tbody>
          </table>
        </${Modal}>`
      : null}
  </div>`;
}


// ─── extra_params: конверсия UI ↔ JSON ───
//
// В JSON-теле запроса ключи могут быть разного типа: строка ("low"),
// boolean (false), число (0.2), вложенный объект (chat_template_kwargs).
// В UI показываем однострочное значение + бейдж типа. При вводе пытаемся
// распарсить как JSON: получилось → берём распарсенное; нет → строка как есть.
// Так пользователь пишет `low` без кавычек, `false` как bool, объект — JSON'ом.

function parseExtraValue(raw) {
  const t = (raw == null ? "" : String(raw)).trim();
  if (t === "") return { kind: "string", value: "" };
  try {
    const v = JSON.parse(t);
    if (v === null) return { kind: "null", value: null };
    if (typeof v === "boolean") return { kind: "bool", value: v };
    if (typeof v === "number") return { kind: "num", value: v };
    if (typeof v === "string") return { kind: "string", value: v };
    if (Array.isArray(v)) return { kind: "arr", value: v };
    if (typeof v === "object") return { kind: "obj", value: v };
    return { kind: "string", value: t };
  } catch {
    return { kind: "string", value: t };
  }
}

function stringifyExtraValue(v) {
  // Строку показываем без кавычек — удобнее редактировать.
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

function extraParamsToRows(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.keys(obj).sort().map((k) => ({
    key: k,
    valueStr: stringifyExtraValue(obj[k]),
  }));
}

function rowsToExtraParams(rows) {
  const out = {};
  for (const r of rows) {
    const k = (r.key || "").trim();
    if (!k) continue;
    out[k] = parseExtraValue(r.valueStr).value;
  }
  return Object.keys(out).length ? out : null;
}

// Пресеты — типовые наборы для популярных провайдеров. Пользователь
// применяет и сам решает, оставить как есть или отредактировать.
// НЕ применяются автоматически: пустой extra_params = ничего не шлём.
const LLM_EXTRA_PARAM_PRESETS = [
  {
    id: "gemini_reasoning_low",
    label: "Gemini: reasoning low",
    rows: [{ key: "reasoning_effort", valueStr: "low" }],
  },
  {
    id: "vllm_disable_thinking",
    label: "vLLM: выкл. thinking",
    rows: [{ key: "chat_template_kwargs", valueStr: '{"enable_thinking": false}' }],
  },
  {
    id: "deepseek_no_reasoning",
    label: "DeepSeek-R1: без reasoning",
    rows: [{ key: "include_reasoning", valueStr: "false" }],
  },
];

function extraValueKindLabel(kind) {
  return { string: "str", bool: "bool", num: "num", null: "null",
           arr: "arr", obj: "obj" }[kind] || kind;
}

function ExtraParamsEditor({ rows, onChange }) {
  function updateRow(i, patch) {
    const next = rows.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }
  function removeRow(i) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function addRow() {
    onChange([...rows, { key: "", valueStr: "" }]);
  }
  function applyPreset(preset) {
    // Добавляем пары пресета, перезаписывая по ключу (не дублируем).
    const map = new Map(rows.map((r) => [r.key, r]));
    for (const r of preset.rows) map.set(r.key, { ...r });
    onChange([...map.values()]);
  }

  return html`<div class="form-section">
    <div class="form-section-title">
      Расширенные параметры запроса
      <${InfoHint} text="Параметры уходят провайдеру как есть. Пустой список = ничего не отправляем. Если провайдер не поддерживает параметр — вернёт ошибку, её увидит кнопка «Проверить связь»." />
    </div>

    <div class="banner warn">
      Параметры экспериментальные. Провайдер может их отвергнуть — тогда
      запросы к LLM начнут падать. Проверяйте кнопкой «Проверить связь».
    </div>

    ${rows.length === 0
      ? html`<div class="muted small">Параметров нет — в тело запроса ничего не добавляется.</div>`
      : html`<div class="llm-extra-rows">
          ${rows.map((row, i) => {
            const kind = parseExtraValue(row.valueStr).kind;
            return html`<div class="llm-extra-row" key=${i}>
              <input class="mono llm-extra-key" placeholder="ключ"
                     value=${row.key}
                     onInput=${(e) => updateRow(i, { key: e.target.value })} />
              <input class="mono llm-extra-value" placeholder="значение (JSON или строка)"
                     value=${row.valueStr}
                     onInput=${(e) => updateRow(i, { valueStr: e.target.value })} />
              <span class=${"llm-extra-kind kind-" + kind}>${extraValueKindLabel(kind)}</span>
              <button type="button" class="llm-extra-del"
                      title="Убрать параметр"
                      onClick=${() => removeRow(i)}>×</button>
            </div>`;
          })}
        </div>`}

    <div class="row llm-extra-actions">
      <button type="button" class="btn btn-sm" onClick=${addRow}>+ Параметр</button>
      ${rows.length > 0
        ? html`<button type="button" class="btn btn-sm btn-ghost"
                        onClick=${() => onChange([])}>Сбросить</button>`
        : null}
    </div>

    <div class="llm-extra-presets">
      <span class="muted small">Типовые наборы:</span>
      ${LLM_EXTRA_PARAM_PRESETS.map((pr) => html`<button type="button" key=${pr.id}
          class="llm-extra-preset"
          onClick=${() => applyPreset(pr)}>${pr.label}</button>`)}
    </div>
  </div>`;
}


// Модалка экспорта профиля
function ExportProfileModal({ onClose }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (password.length < 12) { setErr("Пароль не короче 12 символов"); return; }
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/v1/profiles/export", {
        method: "POST",
        headers: {
          "X-Session-Token": sessionToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password })
      });
      if (!res.ok) {
        const data = await res.json().catch(()=>({}));
        throw new Error((data.error && data.error.message) || "Ошибка экспорта");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `profile-export-${new Date().toISOString().slice(0,10)}.melecho`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("Экспорт готов", "ok");
      onClose();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<${Modal} title="Экспорт профиля" onClose=${onClose}
    footer=${html`<div class="row">
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onClose} disabled=${busy}>Отмена</button>
      <div class="grow"></div>
      <button type="button" class="btn btn-primary btn-sm" disabled=${busy || password.length < 12} onClick=${submit}>
        ${busy ? "Экспорт…" : "Скачать архив"}
      </button>
    </div>`}>
    <p class="muted small">
      Архив содержит всю базу данных профиля (включая зашифрованные ключи SSH и LLM)
      и ключ аудита. Он будет зашифрован указанным ниже паролем.
    </p>
    <label>Пароль архива (≥ 12 символов)</label>
    <input type="password" autocomplete="new-password" value=${password} onInput=${(e) => setPassword(e.target.value)} />
    ${err ? html`<div class="err">${err}</div>` : null}
  </${Modal}>`;
}

// Модалка импорта профиля
function ImportProfileModal({ onClose }) {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(() => "Импорт " + new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  function onFileChange(e) {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) { setErr("Выберите файл"); return; }
    if (password.length < 12) { setErr("Пароль не короче 12 символов"); return; }
    if (!name.trim()) { setErr("Укажите имя для нового профиля"); return; }
    setBusy(true); setErr("");

    const form = new FormData();
    form.append("archive", file);
    form.append("password", password);
    form.append("profile_name", name.trim());

    try {
      const res = await fetch("/api/v1/profiles/import", {
        method: "POST",
        headers: { "X-Session-Token": sessionToken },
        body: form
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data.error && data.error.message) || "Ошибка импорта");
      }
      showToast("Профиль импортирован", "ok");
      sessionToken = "";
      try { sessionStorage.removeItem("melecho.session"); } catch {}
      const newUrl = "/?pi=" + Date.now() + "#bootstrap=" + encodeURIComponent(data.bootstrap);
      location.replace(newUrl);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  }

  return html`<${Modal} title="Импорт профиля" onClose=${onClose}
    footer=${html`<div class="row">
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onClose} disabled=${busy}>Отмена</button>
      <div class="grow"></div>
      <button type="button" class="btn btn-primary btn-sm" disabled=${busy || !file || !name.trim() || password.length < 12} onClick=${submit}>
        ${busy ? "Импорт…" : "Импортировать"}
      </button>
    </div>`}>
    <p class="muted small">
      Выберите файл архива (.melecho) и введите пароль, который использовался при экспорте.
      Будет создан новый профиль. Пароль архива станет мастер-паролем нового профиля.
    </p>
    
    <div class=${"file-drop" + (dragOver ? " dragover" : "")}
         onClick=${() => fileRef.current && fileRef.current.click()}
         onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
         onDragLeave=${() => setDragOver(false)}
         onDrop=${onDrop}>
      <input type="file" ref=${fileRef} accept=".melecho" onChange=${onFileChange} />
      ${file 
        ? html`<div class="mono">${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)</div>`
        : html`<div>Перетащите файл сюда или нажмите для выбора</div>`}
    </div>

    <label>Имя нового профиля</label>
    <input value=${name} onInput=${(e) => setName(e.target.value)} placeholder="например, Импорт 2026" />

    <label>Пароль архива</label>
    <input type="password" autocomplete="off" value=${password} onInput=${(e) => setPassword(e.target.value)} />
    
    ${err ? html`<div class="err">${err}</div>` : null}
  </${Modal}>`;
}

// ProfileSection: блок «Профиль» в Настройках. Управляет ТОЛЬКО
// текущим (активным) профилем: переименование, смена мастер-пароля,
// удаление. Переключение между профилями — на стартовом экране
// (см. ProfileSwitcher); сюда его не тащим, потому что из
// работающей панели переключение возможно только через
// unload (Выйти из профиля) — иначе сессии, SSH-сессии, DEK
// остались бы от старого профиля.
//
// Экспорт/импорт — в 1.1.0, отдельной итерацией.
function ProfileSection() {
  const [info, setInfo] = useState(null);       // {slug, name}
  const [nameDraft, setNameDraft] = useState("");
  // Delayed-tooltip на slug (появляется через 1 сек, исчезает мгновенно).
  // Хук — тот же, что у ModePill; рендерит tooltip в document.body,
  // поэтому карточка не расширяется и tooltip не обрезается modal'ом.
  const slugTip = useDelayedTooltip(
    "Идентификатор профиля. Из него строится путь к каталогу данных "
    + "(~/.local/share/melecho/profiles/<slug>/). Не меняется при "
    + "переименовании."
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // Модалки. Отдельные модалки, а не inline-формы: пароль (3 поля) и
  // удаление (ввод имени + описание последствий) слишком громоздки
  // для inline-интерфейса и оба требуют фокуса и явного подтверждения.
  const [pwOpen, setPwOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [expOpen, setExpOpen] = useState(false);

  async function load() {
    try {
      const r = await api("/api/v1/profiles");
      const a = (r.items || []).find((p) => p.slug === r.active_slug);
      if (a) {
        setInfo({ slug: a.slug, name: a.name });
        setNameDraft(a.name);
      }
    } catch (ex) {
      setErr(ex.message);
    }
  }
  useEffect(() => { load(); }, []);

  async function doRename() {
    const next = (nameDraft || "").trim();
    if (!next || !info) return;
    if (next === info.name) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api("/api/v1/profiles/current", {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      setInfo({ slug: r.slug, name: r.name });
      setNameDraft(r.name);
      setOk("Имя сохранено");
      setTimeout(() => setOk(""), 2500);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return html`<div class="card stack">
      <h3>Профиль</h3>
      <p class="muted">Загрузка…</p>
    </div>`;
  }

  return html`<div class="card stack">
    <h3>Профиль</h3>
    <p class="muted small">
      Изолированный набор данных: своя БД, свой ключ аудита, свой каталог
      пользовательских операций. Переключение между профилями — на
      стартовом экране.
    </p>

    <div class="profile-row">
      <div class="profile-row-name">
        <label>Имя профиля</label>
        <div class="profile-row-input">
          <input class="grow" value=${nameDraft}
                 disabled=${busy}
                 maxlength="64"
                 onInput=${(e) => setNameDraft(e.target.value)}
                 onKeyDown=${(e) => { if (e.key === "Enter") doRename(); }} />
          <button type="button" class="btn btn-sm btn-primary"
                  disabled=${busy
                    || !nameDraft.trim()
                    || nameDraft.trim() === info.name}
                  onClick=${doRename}>
            ${busy ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </div>
      <div class="profile-row-slug">
        <label>slug</label>
        <div class="profile-slug-box mono"
             ref=${slugTip.ref}
             onPointerEnter=${slugTip.onPointerEnter}
             onPointerLeave=${slugTip.onPointerLeave}>${info.slug}</div>
      </div>
    </div>

    <div class="row">
      <button type="button" class="btn btn-sm"
              disabled=${busy}
              onClick=${() => setPwOpen(true)}>Сменить мастер-пароль</button>
      <button type="button" class="btn btn-sm"
              disabled=${busy}
              onClick=${() => setExpOpen(true)}>Экспорт</button>
      <div class="grow"></div>
      <button type="button" class="btn btn-sm btn-danger"
              disabled=${busy}
              onClick=${() => setDelOpen(true)}>Удалить профиль</button>
    </div>

    ${ok ? html`<div class="banner ok">${ok}</div>` : null}
    ${err ? html`<div class="err">${err}</div>` : null}

    ${pwOpen
      ? html`<${ChangePasswordModal}
            onClose=${() => setPwOpen(false)}
            onDone=${() => {
              setPwOpen(false);
              setOk("Мастер-пароль изменён");
              setTimeout(() => setOk(""), 2500);
            }} />`
      : null}
    ${delOpen
      ? html`<${DeleteProfileModal}
            profileName=${info.name}
            onClose=${() => setDelOpen(false)}
            onDeleted=${(r) => {
              // Удаление всегда переключает на другой профиль и
              // требует reload (сессия инвалидируется). Backend уже
              // сбросил state — просто идём на новый bootstrap.
              sessionToken = "";
              try { sessionStorage.removeItem("melecho.session"); } catch {}
              const bs = r && r.bootstrap;
              if (bs) {
                location.replace("/?pd=" + Date.now()
                  + "#bootstrap=" + encodeURIComponent(bs));
              } else {
                location.reload();
              }
            }} />`
      : null}
    ${expOpen
      ? html`<${ExportProfileModal} onClose=${() => setExpOpen(false)} />`
      : null}
  </div>`;
}


// ChangePasswordModal: три поля (старый / новый / подтверждение).
// DEK не пересоздаётся — сменится только обёртка. Все живые сессии,
// SSH-соединения и расшифрованные секреты в памяти остаются.
function ChangePasswordModal({ onClose, onDone }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const cls = pwClass(newPw);

  async function submit(e) {
    if (e) e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await api("/api/v1/profiles/change-password", {
        method: "POST",
        body: JSON.stringify({
          old_password: oldPw,
          new_password: newPw,
          new_password_confirm: confirm,
        }),
      });
      onDone && onDone();
    } catch (ex) {
      setErr(ex && ex.message ? ex.message : String(ex));
      setBusy(false);
    }
  }

  const disabled = busy
    || !oldPw
    || newPw.length < 12
    || newPw !== confirm;

  return html`<${Modal} title="Смена мастер-пароля" onClose=${onClose}
    footer=${html`<div class="row">
      <button type="button" class="btn btn-ghost btn-sm"
              onClick=${onClose} disabled=${busy}>Отмена</button>
      <div class="grow"></div>
      <button type="button" class="btn btn-primary btn-sm"
              disabled=${disabled}
              onClick=${submit}>${busy ? "Смена…" : "Сменить"}</button>
    </div>`}>
    <p class="muted small">
      DEK не пересоздаётся — меняется только пароль его обёртки.
      SSH-соединения, расшифрованные креденшелы и активная сессия
      останутся нетронутыми. Восстановление невозможно: потеря нового
      пароля = потеря доступа к хранилищу.
    </p>

    <label>Текущий пароль</label>
    <input type="password" autocomplete="current-password"
           value=${oldPw} disabled=${busy}
           onInput=${(e) => setOldPw(e.target.value)} />

    <label>Новый пароль (≥ 12 символов)</label>
    <input type="password" autocomplete="new-password"
           value=${newPw} disabled=${busy}
           onInput=${(e) => setNewPw(e.target.value)} />
    ${newPw ? html`<div class=${"pw " + cls}><span></span></div>` : null}

    <label>Подтверждение нового пароля</label>
    <input type="password" autocomplete="new-password"
           value=${confirm} disabled=${busy}
           onInput=${(e) => setConfirm(e.target.value)} />

    ${newPw && confirm && newPw !== confirm
      ? html`<div class="err small">Пароли не совпадают</div>`
      : null}
    ${err ? html`<div class="err">${err}</div>` : null}
  </${Modal}>`;
}


// DeleteProfileModal: подтверждение вводом имени профиля.
// Удаление «последнего профиля» backend отвергает с E_PROFILE_LAST —
// UI подскажет это в тексте ошибки.
function DeleteProfileModal({ profileName, onClose, onDeleted }) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const matches = confirmText === profileName;

  async function submit(e) {
    if (e) e.preventDefault();
    if (!matches || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api("/api/v1/profiles/delete-current", {
        method: "POST",
        body: JSON.stringify({ confirm_name: confirmText }),
      });
      // Backend уже переключил активный профиль. Сессия инвалидирована —
      // нужно заменить URL на новый bootstrap, иначе следующий запрос
      // получит 401 и Root уйдёт в need-boot.
      onDeleted && onDeleted(r);
    } catch (ex) {
      setErr(ex && ex.message ? ex.message : String(ex));
      setBusy(false);
    }
  }

  return html`<${Modal} title="Удалить профиль" onClose=${onClose}
    footer=${html`<div class="row">
      <button type="button" class="btn btn-ghost btn-sm"
              onClick=${onClose} disabled=${busy}>Отмена</button>
      <div class="grow"></div>
      <button type="button" class="btn btn-danger btn-sm"
              disabled=${!matches || busy}
              onClick=${submit}>${busy ? "Удаление…" : "Удалить"}</button>
    </div>`}>
    <p class="muted">
      Будут удалены <b>все данные профиля</b>: база данных, ключ аудита,
      расшифрованные креденшелы (они хранятся в БД), история алертов,
      операции. Действие необратимо.
    </p>
    <p class="muted small">
      После удаления панель переключится на первый оставшийся профиль
      (по алфавиту slug). Нельзя удалить последний профиль.
    </p>

    <label>Введите имя профиля для подтверждения</label>
    <input class="mono" value=${confirmText}
           disabled=${busy}
           placeholder=${profileName}
           onInput=${(e) => setConfirmText(e.target.value)}
           onKeyDown=${(e) => { if (e.key === "Enter") submit(e); }} />
    ${confirmText && !matches
      ? html`<div class="muted small">Не совпадает с «${profileName}»</div>`
      : null}
    ${err ? html`<div class="err">${err}</div>` : null}
  </${Modal}>`;
}


function LLMProfilesSection() {
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [presets, setPresets] = useState({});
  const [availableModels, setAvailableModels] = useState([]);
  const [modelsBusy, setModelsBusy] = useState(false);

  async function load() {
    const [p, pr] = await Promise.all([
      api("/api/v1/llm/profiles"),
      api("/api/v1/llm/presets"),
    ]);
    setProfiles(p.items || []);
    setActiveId(p.active_id);
    setPresets(pr.items || {});
  }
  useEffect(() => { load().catch((e) => setErr(e.message)); }, []);

  function startNew() {
    const prov = "deepseek";
    const preset = presets[prov] || {};
    setEditing({
      provider: prov,
      name: preset.label || "DeepSeek",
      base_url: preset.base_url || "",
      model: preset.model || "",
      api_key: "",
      // create: api_key включается в body всегда (пусть backend валидирует).
      api_key_changed: true,
      has_api_key: false,
      extra_rows: [],
    });
    setTestResult(null);
    setAvailableModels([]);
    setErr("");
  }
  function startEdit(p) {
    // Повторный клик по «Правка» той же карточки — закрывает редактор,
    // симметрично «Отмена».
    if (editing && editing.id === p.id) {
      setEditing(null);
      setTestResult(null);
      return;
    }
    setEditing({
      id: p.id,
      provider: p.provider,
      name: p.name,
      base_url: p.base_url,
      model: p.model,
      api_key: "",
      // edit: ключ не показываем (зашифрован на бэке). Если пользователь
      // не ввёл новый — в body его не включаем, и backend не трогает
      // сохранённый. Это и был баг: раньше пустое поле стирало ключ.
      api_key_changed: false,
      has_api_key: !!p.has_api_key,
      extra_rows: extraParamsToRows(p.extra_params),
    });
    setTestResult(null);
    setAvailableModels([]);
    setErr("");
  }
  function onProviderChange(prov) {
    const preset = presets[prov] || {};
    setEditing(Object.assign({}, editing, {
      provider: prov,
      base_url: preset.base_url || "",
      model: preset.model || "",
      name: editing.id ? editing.name : (preset.label || prov),
    }));
  }
  async function loadModels() {
    setModelsBusy(true);
    setErr("");
    try {
      const body = { base_url: editing.base_url };
      if (editing.id) body.id = editing.id;
      // api_key шлём ТОЛЬКО когда пользователь его менял. Иначе backend
      // подтянет сохранённый по id профиля. Раньше отправляли "" — и в
      // режиме правки получали HTTP 404 от Gemini (ключ фактически пустой).
      if (editing.api_key_changed) body.api_key = editing.api_key;
      const r = await api("/api/v1/llm/profiles/models", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setAvailableModels(r.items || []);
      if ((r.items || []).length === 0) {
        setErr("провайдер вернул пустой список моделей");
      }
    } catch (ex) {
      setErr(ex.message);
      setAvailableModels([]);
    } finally {
      setModelsBusy(false);
    }
  }

  async function test() {
    setBusy(true); setErr(""); setTestResult(null);
    try {
      const r = await api("/api/v1/llm/profiles/test", { method: "POST", body: JSON.stringify(bodyFromEditing()) });
      setTestResult(r);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  // Собирает тело запроса из формы: extra_rows → extra_params.
  // В body всегда присутствует extra_params (null, если rows пусты) —
  // backend это корректно нормализует. Отсутствие ключа оставлено
  // семантикой «не трогать» — но UI всегда шлёт явно.
  function bodyFromEditing() {
    const body = {
      provider: editing.provider,
      name: editing.name,
      base_url: editing.base_url,
      model: editing.model,
      extra_params: rowsToExtraParams(editing.extra_rows || []),
    };
    // id профиля: нужен для «Проверить связь» — если ключ не менялся,
    // backend подтянет его из этого профиля. Без id тест падал бы с 400.
    if (editing.id) {
      body.id = editing.id;
    }
    // api_key кладём в body ТОЛЬКО когда пользователь реально его менял.
    // В edit-режиме пустое непротронутое поле — не шлём: backend
    // сохранит существующий ключ. Специальное «удалить ключ» — тоже
    // api_key_changed, но с пустой строкой, и тогда backend стирает.
    if (editing.api_key_changed) {
      body.api_key = editing.api_key;
    }
    return body;
  }

  async function save() {
    setBusy(true); setErr("");
    try {
      const body = bodyFromEditing();
      if (editing.id) {
        await api("/api/v1/llm/profiles/" + editing.id, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/api/v1/llm/profiles", { method: "POST", body: JSON.stringify(body) });
      }
      setEditing(null); setTestResult(null);
      await load();
      window.dispatchEvent(new Event("melecho:refresh-llm-profiles"));
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }
  async function activate(pid) {
    try {
      await api("/api/v1/llm/profiles/" + pid + "/activate", { method: "POST", body: "{}" });
      await load();
      window.dispatchEvent(new Event("melecho:refresh-llm-profiles"));
    } catch (ex) { setErr(ex.message); }
  }
  async function remove(pid) {
    if (!confirm("Удалить профиль?")) return;
    try {
      await api("/api/v1/llm/profiles/" + pid, { method: "DELETE" });
      await load();
      window.dispatchEvent(new Event("melecho:refresh-llm-profiles"));
    } catch (ex) { setErr(ex.message); }
  }

  return html`<div class="card stack">
    <h3>Профили LLM</h3>
    <p class="muted">
      Профиль — сохранённые провайдер, base URL, модель и ключ. Локальные провайдеры ключ не требуют.
    </p>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${profiles.length === 0
      ? html`<p class="muted">Профилей пока нет.</p>`
      : html`<div class="profile-list">
          ${profiles.map((p) => html`<div class=${"profile-item " + (p.is_active ? "active" : "")}>
            <div class="row">
              <label class="check grow">
                <input type="radio" name="llm-active" checked=${p.is_active} onChange=${() => activate(p.id)} />
                <span><b>${p.name}</b> <span class="muted">${p.provider} · ${p.model}</span></span>
              </label>
              ${p.has_api_key ? html`<span class="badge">ключ</span>` : html`<span class="badge">без ключа</span>`}
              <button class="btn btn-sm" onClick=${() => startEdit(p)}>Правка</button>
              <button class="btn btn-sm btn-danger" onClick=${() => remove(p.id)}>×</button>
            </div>
            <div class="mono muted small">${p.base_url}</div>
          </div>`)}
        </div>`}
    ${editing
      ? html`<div class="profile-form stack">
          <label>Провайдер</label>
          <select value=${editing.provider} onChange=${(e) => onProviderChange(e.target.value)}>
            ${Object.entries(presets).map(([k, v]) => html`<option value=${k}>${v.label}</option>`)}
          </select>
          <label>Название</label>
          <input value=${editing.name} onInput=${(e) => setEditing(Object.assign({}, editing, { name: e.target.value }))} />
          <label>Base URL</label>
          <input class="mono" value=${editing.base_url} onInput=${(e) => setEditing(Object.assign({}, editing, { base_url: e.target.value }))} />
          <label>Модель</label>
          <div class="row">
            <${ModelCombobox}
                value=${editing.model}
                onChange=${(v) => setEditing(Object.assign({}, editing, { model: v }))}
                options=${availableModels}
                placeholder="модель (можно ввести свою)" />
            <button type="button" class="btn btn-sm" disabled=${modelsBusy || !editing.base_url.trim()} onClick=${loadModels}>
              ${modelsBusy ? "Запрос…" : "Загрузить модели"}
            </button>
          </div>
          ${availableModels.length
            ? html`<div class="muted small">Получено ${availableModels.length} моделей — нажмите стрелку, чтобы выбрать, или введите свою в поле.</div>`
            : null}
          <label>
            API-ключ
            ${editing.id && editing.has_api_key && !editing.api_key_changed
              ? html`<span class="muted small"> · сохранён</span>`
              : null}
          </label>
          <div class="row">
            <input type="password" autocomplete="off" class="grow"
                   placeholder=${editing.id && editing.has_api_key && !editing.api_key_changed
                     ? "••••••••  (не менять — оставьте пустым)"
                     : ""}
                   value=${editing.api_key}
                   onInput=${(e) => setEditing(Object.assign({}, editing, {
                     api_key: e.target.value,
                     api_key_changed: true,
                   }))} />
            ${editing.id && editing.has_api_key && !editing.api_key_changed
              ? html`<button type="button" class="btn btn-sm btn-ghost"
                            title="Стереть сохранённый ключ"
                            onClick=${() => setEditing(Object.assign({}, editing, {
                              api_key: "",
                              api_key_changed: true,
                              has_api_key: false,
                            }))}>Удалить ключ</button>`
              : null}
            ${editing.id && editing.api_key_changed && editing.has_api_key
              ? html`<button type="button" class="btn btn-sm btn-ghost"
                            title="Отменить замену ключа"
                            onClick=${() => setEditing(Object.assign({}, editing, {
                              api_key: "",
                              api_key_changed: false,
                            }))}>Отменить</button>`
              : null}
          </div>
          <${ExtraParamsEditor}
              rows=${editing.extra_rows || []}
              onChange=${(rows) => setEditing(Object.assign({}, editing, { extra_rows: rows }))} />
          ${testResult
            ? (testResult.ok
                // При успехе показываем только «Связь есть · N мс». Сырой
                // ответ модели в UI не нужен — может быть шум (reasoning-
                // маркеры, ремарки), а связь и так проверена.
                ? html`<div class="banner ok">Связь есть · ${testResult.elapsed_ms} мс</div>`
                : html`<div class="err">${testResult.code}: ${testResult.message}</div>`)
            : null}
          <div class="row">
            <button type="button" class="btn btn-sm" disabled=${busy} onClick=${test}>Проверить связь</button>
            <button type="button" class="btn btn-sm btn-primary" disabled=${busy || !editing.name.trim() || !editing.base_url.trim() || !editing.model.trim()} onClick=${save}>Сохранить</button>
            <button type="button" class="btn btn-sm btn-ghost" onClick=${() => { setEditing(null); setTestResult(null); }}>Отмена</button>
          </div>
        </div>`
      : html`<button class="btn" onClick=${startNew}>+ Новый профиль</button>`}
  </div>`;
}

function fmtAgo(z) {
  if (!z) return "—";
  try {
    const t = new Date(z.endsWith("Z") ? z : z + "Z").getTime();
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return sec + " с назад";
    if (sec < 3600) return Math.round(sec / 60) + " мин назад";
    if (sec < 86400) return Math.round(sec / 3600) + " ч назад";
    return Math.round(sec / 86400) + " дн назад";
  } catch { return z; }
}

function AlertDetailModal({ alertId, onClose, onReload, llmEnabled, onExplain, servers, onOpenRule }) {
  const [alert, setAlert] = useState(null);
  const [events, setEvents] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [rule, setRule] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [a, ev, rc] = await Promise.all([
        api("/api/v1/alerts/" + alertId),
        api("/api/v1/alerts/" + alertId + "/events"),
        api("/api/v1/reactions?alert_id=" + alertId + "&limit=50"),
      ]);
      setAlert(a);
      setEvents(ev.items || []);
      setReactions(rc.items || []);
      // Правило — опционально. Если удалено (rule_id=NULL или 404),
      // просто не показываем ссылку. Ошибку глотаем осознанно.
      if (a && a.rule_id) {
        try {
          const r = await api("/api/v1/alert-rules/" + a.rule_id);
          setRule(r);
        } catch { setRule(null); }
      } else {
        setRule(null);
      }
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, [alertId]);

  // Пока открыт AlertDetailModal — обновляем реакции/события раз в 4 с.
  useEffect(() => {
    const iv = setInterval(() => { load(); }, 4000);
    return () => clearInterval(iv);
  }, [alertId]);

  async function act(kind, extra) {
    setBusy(true); setErr("");
    try {
      const base = "/api/v1/alerts/" + alertId;
      if (kind === "ack")          await api(base + "/ack", { method: "POST", body: "{}" });
      else if (kind === "dismiss") await api(base + "/dismiss", { method: "POST", body: "{}" });
      else if (kind === "mute")    await api(base + "/mute", { method: "POST", body: JSON.stringify({ minutes: extra }) });
      else if (kind === "delete") {
        await api(base, { method: "DELETE" });
        onReload && onReload();
        onClose && onClose();
        return;
      }
      await load();
      onReload && onReload();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  const sevClass = alert
    ? (alert.severity === "critical" ? "danger" : alert.severity === "warning" ? "warn" : "")
    : "";

  return html`<${Modal} title=${alert ? alert.title : "Алерт"} onClose=${onClose}
    footer=${alert ? html`<div class="row">
      ${alert.status !== "resolved" && alert.status !== "dismissed"
        ? html`<button class="btn btn-sm" disabled=${busy} onClick=${() => act("ack")}>Взять в работу</button>
               <button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => act("dismiss")}>Скрыть</button>
               <span class="muted small">Mute:</span>
               <button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => act("mute", 15)}>15 мин</button>
               <button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => act("mute", 60)}>1 ч</button>
               <button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => act("mute", 1440)}>24 ч</button>`
        : null}
      <div class="grow"></div>
      <button class="btn btn-sm btn-danger" disabled=${busy} onClick=${() => act("delete")}>Удалить</button>
      <button class="btn btn-sm btn-ghost" onClick=${onClose}>Закрыть</button>
    </div>` : null}>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${!alert
      ? html`<p class="muted">Загрузка…</p>`
      : html`<div class="stack">
          <div class="row">
            <span class=${"badge " + sevClass}>${alert.severity}</span>
            <span class="badge">${alert.status}</span>
            ${alert.repeat_count > 1 ? html`<span class="alert-repeat">×${alert.repeat_count}</span>` : null}
            <span class="muted small mono">${alert.source}</span>
          </div>
          ${alert.description ? html`<div class="alert-card-desc">${alert.description}</div>` : null}
          <dl class="alert-detail-meta">
            <dt>ID</dt><dd>#${alert.id}</dd>
            <dt>Сервер</dt><dd>${(() => {
              const srv = (servers || []).find((s) => s.id === alert.server_id);
              return srv ? srv.name : (alert.llm_alias || "—");
            })()}</dd>
            <dt>Метрика</dt><dd>${metricLabel(alert.metric)}</dd>
            <dt>Источник</dt><dd>${sourceLabel(alert.source)}</dd>
            ${rule
              ? html`
                  <dt>Тип условия</dt><dd>${conditionKindLabel(rule.condition_kind)}</dd>
                  <dt>Правило</dt>
                  <dd>
                    <a href="#" onClick=${(e) => {
                      e.preventDefault();
                      onOpenRule && onOpenRule(rule);
                    }}>${rule.name} #${rule.id}</a>
                  </dd>`
              : null}
            <dt>Первое событие</dt><dd>${alert.first_seen_at || "—"}</dd>
            <dt>Последнее</dt><dd>${alert.last_seen_at || "—"}</dd>
            ${alert.value != null ? html`<dt>Значение</dt><dd>${alert.value}</dd>` : null}
            ${alert.threshold != null ? html`<dt>Порог</dt><dd>${alert.threshold}</dd>` : null}
            ${alert.resolved_at ? html`<dt>Решено</dt><dd>${alert.resolved_at} (${alert.resolved_by || "—"})</dd>` : null}
            ${alert.muted_until ? html`<dt>Mute до</dt><dd>${alert.muted_until}</dd>` : null}
          </dl>
          <div class="row">
            <button class="btn btn-sm" disabled=${!alert.server_id} onClick=${() => onClose && onExplain(alert, true)}>
              Открыть сервер
            </button>
            ${llmEnabled
              ? html`<${SymBtn} symbol="↗"
                  tooltip="Передать алерт в LLM-чат"
                  onClick=${() => exportAlertToLLM(alert)} />`
              : html`<span class="muted small">LLM выключен</span>`}
          </div>
          <h3 class="h2" style="font-size:1rem;margin-top:8px">История</h3>
          ${events.length === 0
            ? html`<p class="muted">Событий нет.</p>`
            : html`<div class="alert-history">
                ${events.map((e) => html`<div class="alert-history-item" key=${e.id}>
                  <span class=${"alert-history-kind " + e.kind}>${e.kind}</span>
                  <span>${e.meta && e.meta.reason ? e.meta.reason : ""}</span>
                  <span class="row" style="gap:8px">
                    <span class="alert-history-time">${e.timestamp_utc}</span>
                    <span class="alert-history-actor">${e.actor}</span>
                  </span>
                </div>`)}
              </div>`}

          <h3 class="h2" style="font-size:1rem;margin-top:8px">Реакции</h3>
          ${reactions.length === 0
            ? html`<p class="muted">На этот алерт реакций не запускалось.</p>`
            : html`<div class="alert-history">
                ${reactions.map((r) => html`<div class="alert-history-item" key=${r.id}>
                  <${RelStatusBadge} status=${r.status} />
                  <span class="mono">
                    ${r.operation_id}
                    ${r.error_code ? " · " + r.error_code : (r.exit_code != null ? " · exit " + r.exit_code : "")}
                  </span>
                  <span class="alert-history-time">
                    ${r.timestamp_utc}${r.duration_ms != null ? html` · ${r.duration_ms} мс` : null}
                  </span>
                </div>`)}
              </div>`}
        </div>`}
  </${Modal}>`;
}

// Человекочитаемые метки метрик и источников алертов. Используются
// в meta карточки и в модалке. Держим здесь, чтобы единый источник
// правды — если добавим новые метрики, правим здесь.
const METRIC_LABELS = {
  cpu: "CPU",
  ram: "RAM",
  disk: "Диск",
  load_1m: "Load 1m",
  net_rx_bps: "Сеть RX",
  net_tx_bps: "Сеть TX",
};
const SOURCE_LABELS = {
  detector: "детектор",
  threshold: "порог",
  stale: "нет данных",
  operation: "операция",
  check: "проверка",
};
function metricLabel(m) {
  if (!m) return "—";
  return METRIC_LABELS[m] || m;
}
function sourceLabel(s) {
  if (!s) return "—";
  return SOURCE_LABELS[s] || s;
}

// Тип условия правила алерта. Единый источник правды для отображения —
// используется в карточке правила, в AlertDetailModal, в фильтре списка,
// в ReactionRuleEditor (MultiSelect condition_kinds).
const CONDITION_KIND_LABELS = {
  metric_threshold:  "порог метрики",
  metric_zscore:     "аномалия детектора",
  metric_stale:      "нет данных",
  operation_check:   "проверка операции",
  manual_op_failed:  "провал ручной операции",
  reaction_failed:   "провал реакции",
};
function conditionKindLabel(k) {
  if (!k) return "—";
  return CONDITION_KIND_LABELS[k] || k;
}

// Человекочитаемое описание условия правила — массив коротких сегментов.
// Используется во второй строке карточки правила. Для operation_check
// condition_json имеет форму {operation_id, params, expected}; для метрик
// — {metric, value_gte|gt|lte|lt} / {z_min, z_max} / {no_data_sec}.
// Ничего не парсим из строки — если condition_json невалиден, возвращаем
// пустой массив, и карточка просто не покажет условие.
function formatRuleCondition(r) {
  const parts = [];
  const kind = r.condition_kind;
  let cj = {};
  try {
    cj = typeof r.condition_json === "string"
      ? JSON.parse(r.condition_json)
      : (r.condition_json || {});
  } catch { cj = {}; }
  if (!cj || typeof cj !== "object") cj = {};

  if (kind === "metric_threshold") {
    const m = cj.metric || "?";
    const ops = [
      ["value_gte", "≥"], ["value_gt", ">"],
      ["value_lte", "≤"], ["value_lt", "<"],
    ];
    let opSym = "?", val = null;
    for (const [k, sym] of ops) {
      if (cj[k] != null) { opSym = sym; val = cj[k]; break; }
    }
    const mLabel = METRIC_LABELS[m] || m;
    const suffix = (m === "cpu" || m === "ram" || m === "disk") ? "%" : "";
    parts.push(`${mLabel} ${opSym} ${val}${suffix}`);
  } else if (kind === "metric_zscore") {
    if (cj.z_min != null && cj.z_max != null) {
      parts.push(`z ∈ [${cj.z_min}, ${cj.z_max})`);
    } else if (cj.z_min != null) {
      parts.push(`z ≥ ${cj.z_min}`);
    }
  } else if (kind === "metric_stale") {
    const sec = cj.no_data_sec;
    if (sec != null) parts.push(`нет данных ${Math.round(sec / 60)} мин`);
  } else if (kind === "operation_check") {
    const op = cj.operation_id || "?";
    parts.push(`операция ${op}`);
    if (r.interval_sec) parts.push(`каждые ${Math.round(r.interval_sec)}с`);
    const params = cj.params || {};
    if (params.unit) parts.push(params.unit);
  } else if (kind === "manual_op_failed") {
    parts.push(`exit ≠ ${cj.exit_ne ?? 0}`);
  } else if (kind === "reaction_failed") {
    const st = (cj.status_in || []).join(", ");
    if (st) parts.push(`статус ∈ [${st}]`);
  }
  return parts;
}


function AlertsView({ onOpenServer, onExplain, llmEnabled, serverId, hideHeader, initialDetailId, onDetailClosed, onOpenRule }) {
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({
    info: 0, warning: 0, critical: 0,
    active_total: 0, resolved: 0, dismissed: 0, failed: 0, total: 0,
  });
  const [servers, setServers] = useState([]);
  const [sevFilter, setSevFilter] = useState("");
  const [srvFilter, setSrvFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState(initialDetailId ?? null);

  const fixedServerId = serverId != null ? Number(serverId) : null;

  async function load() {
    setErr("");
    try {
      const qs = new URLSearchParams();
      if (sevFilter) qs.set("severity", sevFilter);
      if (fixedServerId != null) qs.set("server_id", String(fixedServerId));
      else if (srvFilter) qs.set("server_id", srvFilter);
      qs.set("status", statusFilter);
      const tasks = [
        api("/api/v1/alerts?" + qs.toString()),
        api("/api/v1/alerts/counts"),
      ];
      if (!hideHeader && fixedServerId == null) tasks.push(api("/api/v1/servers"));
      const res = await Promise.all(tasks);
      const lst = res[0];
      const cnt = res[1];
      const srvs = res[2] || { items: [] };
      // Сортировка: severity (critical → warning → info), потом last_seen desc.
      const ord = { critical: 0, warning: 1, info: 2 };
      const sorted = (lst.items || []).slice().sort((a, b) => {
        const o = (ord[a.severity] ?? 9) - (ord[b.severity] ?? 9);
        if (o !== 0) return o;
        return (b.last_seen_at || "").localeCompare(a.last_seen_at || "");
      });
      setItems(sorted);
      setCounts(cnt);
      setServers(srvs.items || []);
    } catch (ex) {
      setErr(ex.message);
    }
  }

  // Синхронизация внешнего запроса «открыть алерт #N» с внутренним state.
  // Если prop меняется на новое значение — открываем модалку.
  useEffect(() => {
    if (initialDetailId != null) setDetailId(initialDetailId);
  }, [initialDetailId]);
  useEffect(() => { load(); }, [sevFilter, srvFilter, statusFilter, fixedServerId]);
  useEffect(() => {
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
  }, [sevFilter, srvFilter, statusFilter, fixedServerId]);

  // SSE: alert.created/alert.updated → refetch (лёгкий, дебаунс 250 мс).
  // Polling 20 сек остаётся как fallback.
  useEffect(() => {
    let timer = null;
    const onEv = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { load().catch(() => {}); }, 250);
    };
    window.addEventListener("melecho:alert-event", onEv);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("melecho:alert-event", onEv);
    };
  }, [sevFilter, srvFilter, statusFilter, fixedServerId]);

  async function act(a, kind) {
    setBusy(true);
    try {
      if (kind === "ack") await api("/api/v1/alerts/" + a.id + "/ack", { method: "POST", body: "{}" });
      else if (kind === "dismiss") await api("/api/v1/alerts/" + a.id + "/dismiss", { method: "POST", body: "{}" });
      await load();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  const activeTotal = counts.active_total
    ?? ((counts.critical || 0) + (counts.warning || 0) + (counts.info || 0));
  return html`<div class=${hideHeader ? "stack" : "page"}>
    ${hideHeader ? null : html`<div class="srv-head">
      <div>
        <h2 class="h2">
          Алерты
          ${activeTotal > 0
            ? html`<span class=${"nav-badge " + (counts.critical > 0 ? "" : "warn")}>${activeTotal}</span>`
            : null}
        </h2>
        <p class="muted">События от детектора, операций и проверок. Один алерт на метрику с дедупликацией.</p>
      </div>
    </div>`}
    ${err ? html`<p class="err">${err}</p>` : null}

    <div class="alerts-toolbar">
      <div class="alerts-filters">
        <div class="filter-field">
          <label>Severity</label>
          <select value=${sevFilter} onChange=${(e) => setSevFilter(e.target.value)}>
            <option value="">все</option>
            <option value="critical">critical</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
          </select>
        </div>

        ${fixedServerId == null && !hideHeader
          ? html`<div class="filter-field">
              <label>Сервер</label>
              <select value=${srvFilter} onChange=${(e) => setSrvFilter(e.target.value)}>
                <option value="">все</option>
                ${servers.map((s) => html`<option value=${s.id}>${s.name} (${s.llm_alias})</option>`)}
              </select>
            </div>`
          : null}

        <div class="filter-field">
          <label>Статус</label>
          <select value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)}>
            <option value="active">активные</option>
            <option value="all">все</option>
            <option value="resolved">решённые</option>
            <option value="dismissed">скрытые</option>
          </select>
        </div>
      </div>

      <div class="alerts-counters">
        <div class="alerts-counter-active">
          <span class="alerts-counter-item critical"><b>${counts.critical || 0}</b><small>critical</small></span>
          <span class="alerts-counter-item warning"><b>${counts.warning || 0}</b><small>warning</small></span>
          <span class="alerts-counter-item info"><b>${counts.info || 0}</b><small>info</small></span>
          <span class="alerts-counter-item total"><b>${activeTotal}</b><small>активных</small></span>
        </div>
        <div class="alerts-counter-sep"></div>
        <div class="alerts-counter-other">
          <span class="alerts-counter-item"><b>${counts.resolved || 0}</b><small>решено</small></span>
          <span class="alerts-counter-item"><b>${counts.dismissed || 0}</b><small>скрыто</small></span>
          <span class="alerts-counter-item"><b>${counts.failed || 0}</b><small>провал</small></span>
          <span class="alerts-counter-item total"><b>${counts.total || 0}</b><small>всего</small></span>
        </div>
      </div>
    </div>

    ${items.length === 0
      ? html`<div class="card empty"><h3>Алертов нет</h3><p class="muted">Всё спокойно.</p></div>`
      : html`<div class="alert-list-page">
          ${items.map((a) => html`<article class=${"alert-card " + a.severity + " " + (a.status === "resolved" ? "resolved" : "")}>
            <div class="alert-card-head">
              <span class=${"badge " + (a.severity === "critical" ? "danger" : a.severity === "warning" ? "warn" : "")}>${a.severity}</span>
              <div class="alert-card-title">${a.title}</div>
              ${a.repeat_count > 1 ? html`<span class="alert-repeat" title="Повторялось ${a.repeat_count} раз">×${a.repeat_count}</span>` : null}
              ${a.status === "acknowledged" ? html`<span class="badge">в работе</span>` : null}
              ${a.status === "resolved" ? html`<span class="badge ok">решено</span>` : null}
              ${a.status === "dismissed" ? html`<span class="badge">скрыто</span>` : null}
            </div>
            ${a.description ? html`<div class="alert-card-desc">${a.description}</div>` : null}
            <div class="alert-card-meta">
              <span title="ID алерта — используется в /explain">ID #${a.id}</span>
              ${(() => {
                const srv = servers.find((s) => s.id === a.server_id);
                const label = srv ? srv.name : (a.llm_alias || ("server-" + a.server_id));
                return a.server_id != null ? html`<span>${label}</span>` : null;
              })()}
              ${a.metric ? html`<span>${metricLabel(a.metric)}</span>` : null}
              <span>${fmtAgo(a.last_seen_at)}</span>
              <span>${sourceLabel(a.source)}</span>
            </div>
            <div class="alert-card-actions">
              ${!fixedServerId && a.server_id != null
                ? html`<button class="btn btn-sm" onClick=${() => onOpenServer(a.server_id)}>Открыть сервер</button>`
                : null}
              <button class="btn btn-sm" onClick=${() => setDetailId(a.id)}>Подробнее</button>
              ${llmEnabled
                ? html`<${SymBtn} symbol="↗"
                    tooltip="Передать алерт в LLM-чат"
                    onClick=${() => exportAlertToLLM(a)} />`
                : null}
              ${a.status !== "resolved" && a.status !== "dismissed"
                ? html`<button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => act(a, "ack")}>Взять в работу</button>
                       <button class="btn btn-sm btn-ghost" disabled=${busy} onClick=${() => act(a, "dismiss")}>Скрыть</button>`
                : null}
            </div>
          </article>`)}
        </div>`}

    ${detailId != null
      ? html`<${AlertDetailModal}
            alertId=${detailId}
            servers=${servers}
            llmEnabled=${llmEnabled}
            onClose=${() => { setDetailId(null); if (onDetailClosed) onDetailClosed(); }}
            onExplain=${(al, openServer) => {
              setDetailId(null);
              if (openServer) onOpenServer(al.server_id);
              else onExplain(al);
            }}
            onOpenRule=${onOpenRule}
            onReload=${load} />`
      : null}
  </div>`;
}

function InfoHint({ text }) {
  return html`<span class="info-hint" data-tip=${text}>i</span>`;
}

// Combobox для поля «Модель».
//
// Заменяет нативный <input list="..."> + <datalist>: у datalist индикатор
// в Chrome не кликабельный (открыть список можно только из фокуса поля
// или при вводе), а его стрелка визуально отличается от стрелки <select>.
//
// Здесь: input остаётся редактируемым (можно ввести свою модель),
// кнопка-стрелка рядом открывает наш dropdown со списком доступных
// моделей и полем-фильтром. Клик по элементу списка подставляет значение.
// Клик вне — закрывает. Escape — закрывает.
function ModelCombobox({ value, onChange, options, placeholder }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const wrapRef = useRef(null);
  const filterRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setFilter("");
      }
    }
    function onKey(e) {
      if (e.key === "Escape") { setOpen(false); setFilter(""); }
    }
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && filterRef.current) {
      try { filterRef.current.focus(); } catch {}
    }
  }, [open]);

  const q = (filter || "").trim().toLowerCase();
  const visible = q
    ? options.filter((m) => String(m).toLowerCase().includes(q))
    : options;

  return html`<div class="model-combo" ref=${wrapRef}>
    <input class="model-combo-input"
           value=${value || ""}
           placeholder=${placeholder || ""}
           onInput=${(e) => onChange(e.target.value)} />
    <button type="button" class="model-combo-arrow"
            disabled=${options.length === 0}
            title=${options.length === 0
              ? "Сначала нажмите «Загрузить модели»"
              : "Показать список моделей"}
            onClick=${() => setOpen((v) => !v)}>
      <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
        <path fill="currentColor" d="M0 0h10L5 6z" />
      </svg>
    </button>
    ${open
      ? html`<div class="model-combo-list">
          <input ref=${filterRef} class="model-combo-filter"
                 placeholder="фильтр" value=${filter}
                 onInput=${(e) => setFilter(e.target.value)} />
          ${options.length === 0
            ? html`<div class="model-combo-empty">Список пуст</div>`
            : visible.length === 0
            ? html`<div class="model-combo-empty">Ничего не найдено</div>`
            : visible.map((m) => html`<button type="button"
                class=${"model-combo-item" + (m === value ? " on" : "")}
                key=${m}
                onClick=${() => {
                  onChange(m);
                  setOpen(false);
                  setFilter("");
                }}>${m}</button>`)}
        </div>`
      : null}
  </div>`;
}

function MultiSelect({ options, selected, onChange, placeholder, emptyText }) {
  // options: [{value, label}]  selected: [value,...]
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [open]);

  const selSet = new Set(selected);
  const selOpts = options.filter((o) => selSet.has(o.value));

  function toggle(v) {
    const s = new Set(selected);
    if (s.has(v)) s.delete(v);
    else s.add(v);
    onChange([...s]);
  }

  return html`<div class="ms-wrap" ref=${wrapRef}>
    ${selOpts.map((o) => html`<span class="ms-chip" key=${o.value}>
      <span class="ms-chip-label">${o.label}</span>
      <button type="button" class="ms-chip-x" onClick=${() => toggle(o.value)}>×</button>
    </span>`)}
    <button type="button" class="ms-open" onClick=${() => setOpen((v) => !v)}>
      ${selOpts.length === 0 ? (placeholder || "выбрать…") : "…"}
    </button>
    ${open
      ? html`<div class="ms-list">
          ${options.length === 0
            ? html`<div class="ms-empty">${emptyText || "нет вариантов"}</div>`
            : options.map((o) => html`<button type="button"
                class=${"ms-item " + (selSet.has(o.value) ? "on" : "")}
                key=${o.value}
                onClick=${() => toggle(o.value)}>
                ${selSet.has(o.value) ? "● " : "○ "}${o.label}
              </button>`)}
        </div>`
      : null}
  </div>`;
}

function Radio({ value, onChange, options }) {
  // options: [{value, label, hint}]
  return html`<div class="radio-group">
    ${options.map((o) => html`<label class="radio-row" key=${o.value}>
      <input type="radio" name=${"_r_" + Math.random().toString(36).slice(2, 8)}
             checked=${value === o.value}
             onChange=${() => onChange(o.value)} />
      <span>${o.label}${o.hint ? html`<span class="radio-hint">${o.hint}</span>` : null}</span>
    </label>`)}
  </div>`;
}

function relStatusClass(s) {
  if (s === "ok") return "ok";
  if (s === "failed" || s === "timeout") return "fail";
  if (s === "pending_confirmation") return "warn";
  if (s === "running") return "running";
  if (s === "cancelled") return "off";
  return "";
}

function RelStatusBadge({ status }) {
  return html`<span class=${"rk-status " + relStatusClass(status)}>${status}</span>`;
}

function PendingReactionsModal({ onClose, onChanged }) {
  const [items, setItems] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState({});

  async function load() {
    setErr("");
    try {
      const r = await api("/api/v1/reactions/pending");
      setItems(r.items || []);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => {
    load();
    const iv = setInterval(load, 3000);
    return () => clearInterval(iv);
  }, []);

  async function act(rid, kind) {
    setBusy((b) => ({ ...b, [rid]: true }));
    setErr("");
    try {
      if (kind === "confirm") {
        await api("/api/v1/reactions/" + rid + "/confirm", { method: "POST", body: "{}" });
      } else {
        await api("/api/v1/reactions/" + rid + "/cancel", {
          method: "POST",
          body: JSON.stringify({ reason: "manual" }),
        });
      }
      // Сразу локально убираем строку — не ждём перезагрузки.
      setItems((list) => list.filter((x) => x.id !== rid));
      // Фоном обновим источник и родителя.
      load().catch(() => {});
      onChanged && onChanged();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy((b) => ({ ...b, [rid]: false })); }
  }

  return html`<${Modal} title="Очередь реакций" onClose=${onClose}
    footer=${html`<div class="row">
      <span class="muted small">Реакции ждут подтверждения из-за sudo, политики confirm или опасной операции.</span>
      <div class="grow"></div>
      <button class="btn btn-sm btn-ghost" onClick=${onClose}>Закрыть</button>
    </div>`}>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${items.length === 0
      ? html`<p class="muted">Очередь пуста.</p>`
      : html`<div class="stack">
          ${items.map((r) => html`<div class="pending-card" key=${r.id}>
            <div class="pending-head">
              <${RelStatusBadge} status=${r.status} />
              <div class="pending-title">${r.operation_id}</div>
            </div>
            <div class="pending-meta">
              <span>alert #${r.alert_id}</span>
              <span>rule #${r.rule_id}</span>
              <span>server #${r.server_id ?? "—"}</span>
              <span>${r.timestamp_utc}</span>
            </div>
            <div class="pending-actions">
              <button class="btn btn-sm btn-primary"
                      disabled=${!!busy[r.id]}
                      onClick=${() => act(r.id, "confirm")}>
                ${busy[r.id] ? "…" : "Подтвердить"}
              </button>
              <button class="btn btn-sm btn-ghost"
                      disabled=${!!busy[r.id]}
                      onClick=${() => act(r.id, "cancel")}>
                Отменить
              </button>
            </div>
          </div>`)}
        </div>`}
  </${Modal}>`;
}

function ReactionDetailModal({ rid, onClose }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      setR(await api("/api/v1/reactions/" + rid));
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, [rid]);

  // Автообновление пока открыта и реакция активна.
  useEffect(() => {
    if (!r) return undefined;
    if (r.status !== "running" && r.status !== "pending_confirmation") return undefined;
    const iv = setInterval(load, 3000);
    return () => clearInterval(iv);
  }, [r && r.status, rid]);

  if (!r) return html`<${Modal} title="Реакция" onClose=${onClose}><p class="muted">Загрузка…</p></${Modal}>`;

  const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? ms + " мс" : (ms / 1000).toFixed(2) + " с");

  return html`<${Modal} title=${"Реакция #" + r.id} onClose=${onClose}>
    ${err ? html`<div class="err">${err}</div>` : null}
    <div class="row">
      <${RelStatusBadge} status=${r.status} />
      <span class="mono">${r.operation_id}</span>
    </div>
    <dl class="alert-detail-meta">
      <dt>Алерт</dt><dd>#${r.alert_id}</dd>
      <dt>Правило</dt><dd>#${r.rule_id}</dd>
      <dt>Сервер</dt><dd>#${r.server_id ?? "—"}</dd>
      <dt>Создано</dt><dd>${r.timestamp_utc}</dd>
      ${r.started_at ? html`<dt>Начато</dt><dd>${r.started_at}</dd>` : null}
      ${r.finished_at ? html`<dt>Завершено</dt><dd>${r.finished_at}</dd>` : null}
      <dt>Длительность</dt><dd>${fmtMs(r.duration_ms)}</dd>
      <dt>Exit code</dt><dd>${r.exit_code ?? "—"}</dd>
      <dt>Sudo</dt><dd>${r.sudo_used ? "да" : "нет"}</dd>
      ${r.error_code ? html`<dt>Ошибка</dt><dd>${r.error_code}</dd>` : null}
      ${r.confirmed_by ? html`<dt>Подтвердил</dt><dd>${r.confirmed_by} в ${r.confirmed_at}</dd>` : null}
    </dl>
    ${r.params_json && r.params_json !== "{}"
      ? html`<div>
          <div class="form-section-title">Параметры</div>
          <pre class="pre">${r.params_json}</pre>
        </div>`
      : null}
    ${r.stdout_trunc
      ? html`<div>
          <div class="form-section-title">Вывод</div>
          ${r.operation_id === "disk_check"
            ? html`<${DiskCheckResult}
                step=${{ phase: "run", exit: r.exit_code, stdout: r.stdout_trunc, stderr: r.stderr_trunc || "" }} />`
            : html`<pre class="pre">${r.stdout_trunc}</pre>`}
        </div>`
      : null}
    ${r.stderr_trunc
      ? html`<div>
          <div class="form-section-title">stderr</div>
          <pre class="pre">${r.stderr_trunc}</pre>
        </div>`
      : null}
    ${!r.stdout_trunc && !r.stderr_trunc && (r.status === "ok" || r.status === "failed")
      ? html`<p class="muted">Вывод команды не сохранён (пустой или уже очищен).</p>`
      : null}
  </${Modal}>`;
}

// Единый редактор правила реакции. Используется:
//   - ReactionsView (Правка / + Новое) — initial = реакция из БД или пустая
//   - AppShell при создании из LLM — initial = конвертированный valid_rule
//
// Сам загружает servers/ops/alert_rules при монтировании: списки нужны
// для селектов. Раньше это жило в ReactionsView, теперь — здесь, чтобы
// компонент можно было вызвать откуда угодно.

const DEFAULT_REACTION_INITIAL = {
  name: "",
  match_rule_ids: [],
  match_severities: ["critical"],
  match_condition_kinds: [],
  match_servers_all: true,
  match_server_ids: [],
  operation_id: "",
  params: "{}",
  run_on_server: "same_as_alert",
  sudo_mode: "never",
  action_policy: "confirm",
  cooldown_sec: 300,
  max_attempts_per_alert: 3,
  max_depth: 3,
  enabled: true,
};

// Legacy-маппинг для чтения старых match_json (до v10). Новые правила
// всегда пишут condition_kinds.
const REACTION_LEGACY_SOURCE_TO_KIND = {
  threshold: "metric_threshold",
  detector:  "metric_zscore",
  stale:     "metric_stale",
  operation: "manual_op_failed",
  check:     "operation_check",
};

function reactionRuleToEditorInitial(r) {
  if (!r) return null;
  const m = r.match || {};
  const srv = m.server_ids || null;
  // condition_kinds — канонический ключ (v10+). Legacy sources —
  // fallback для очень старых данных. Маппинг см. REACTION_LEGACY_SOURCE_TO_KIND.
  let kinds = Array.isArray(m.condition_kinds) ? m.condition_kinds : [];
  if (kinds.length === 0 && Array.isArray(m.sources)) {
    const seen = new Set();
    for (const s of m.sources) {
      const k = REACTION_LEGACY_SOURCE_TO_KIND[s];
      if (k && !seen.has(k)) { seen.add(k); kinds.push(k); }
    }
  }
  return {
    id: r.id,
    name: r.name || "",
    match_rule_ids: m.rule_ids || [],
    match_severities: m.severities || [],
    match_condition_kinds: kinds,
    match_servers_all: srv == null,
    match_server_ids: srv || [],
    operation_id: r.operation_id || "",
    params: JSON.stringify(r.params || {}, null, 2),
    run_on_server: r.run_on_server || "same_as_alert",
    sudo_mode: r.sudo_mode || "never",
    action_policy: r.action_policy || "confirm",
    cooldown_sec: r.cooldown_sec || 300,
    max_attempts_per_alert: r.max_attempts_per_alert || 3,
    max_depth: r.max_depth || 3,
    enabled: !!r.enabled,
  };
}

function llmReactionToEditorInitial(rule) {
  if (!rule) return null;
  return reactionRuleToEditorInitial({
    name: rule.name,
    match: rule.match || {},
    operation_id: rule.operation_id,
    params: rule.params || {},
    run_on_server: rule.run_on_server || "same_as_alert",
    sudo_mode: rule.sudo_mode || "never",
    action_policy: rule.action_policy || "confirm",
    cooldown_sec: rule.cooldown_sec || 300,
    max_attempts_per_alert: rule.max_attempts_per_alert || 3,
    max_depth: rule.max_depth || 3,
    enabled: rule.enabled !== false,
  });
}

function ReactionRuleEditor({ initial, onClose, onSaved, title }) {
  const [editing, setEditing] = useState(initial || DEFAULT_REACTION_INITIAL);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ops, setOps] = useState([]);
  const [servers, setServers] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [o, s, ar] = await Promise.all([
          api("/api/v1/operations"),
          api("/api/v1/servers"),
          api("/api/v1/alert-rules"),
        ]);
        setOps((o.items || []).filter((x) => x.valid));
        setServers(s.items || []);
        setRules(ar.items || []);
        // Если operation_id пустой (создание с нуля) — возьмём первую доступную.
        if (editing && !editing.operation_id && o.items && o.items.length) {
          setEditing({ ...editing, operation_id: o.items[0].id });
        }
      } catch (ex) {
        setErr(ex.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Фильтр правил алертов по выбранным серверам. Глобальные — всегда.
  const filteredAlertRules = useMemo(() => {
    if (!editing || editing.match_servers_all) return rules;
    const sids = new Set(editing.match_server_ids || []);
    if (sids.size === 0) return rules;
    return rules.filter((r) => r.server_id == null || sids.has(r.server_id));
  }, [rules, editing]);

  async function save() {
    if (!editing) return;
    setBusy(true); setErr("");
    try {
      let params;
      try { params = JSON.parse(editing.params || "{}"); }
      catch { throw new Error("params: некорректный JSON"); }
      const match = {
        rule_ids: editing.match_rule_ids,
        severities: editing.match_severities,
        condition_kinds: editing.match_condition_kinds,
        server_ids: editing.match_servers_all ? null : editing.match_server_ids,
      };
      const body = {
        name: editing.name,
        match,
        operation_id: editing.operation_id,
        params,
        run_on_server: editing.run_on_server,
        sudo_mode: editing.sudo_mode,
        action_policy: editing.action_policy,
        cooldown_sec: editing.cooldown_sec,
        max_attempts_per_alert: editing.max_attempts_per_alert,
        max_depth: editing.max_depth,
        enabled: editing.enabled,
      };
      if (editing.id) {
        await api("/api/v1/reaction-rules/" + editing.id, { method: "PATCH", body: JSON.stringify(body) });
        showToast("Реакция сохранена", "ok");
      } else {
        const r = await api("/api/v1/reaction-rules", { method: "POST", body: JSON.stringify(body) });
        showToast("Реакция создана (id: " + r.id + ")", "ok");
      }
      window.dispatchEvent(new Event("melecho:refresh-status"));
      onSaved && onSaved();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) return null;

  const headTitle = title
    || (editing.id ? "Правка правила реакции" : "Новое правило реакции");

  return html`<${Modal} title=${headTitle} onClose=${onClose}
    footer=${html`<div class="row">
      <button class="btn btn-ghost btn-sm" onClick=${onClose}>Отмена</button>
      <div class="grow"></div>
      <button class="btn btn-primary btn-sm"
              disabled=${busy || loading || !editing.name.trim() || !editing.operation_id}
              onClick=${save}>
        ${busy ? "Сохранение…" : "Сохранить"}
      </button>
    </div>`}>
    ${err ? html`<div class="err">${err}</div>` : null}

    <div class="form-label-row">
      <label>Название</label>
      <label class="check check--onoff"
             title=${editing.enabled ? "Выключить реакцию" : "Включить реакцию"}>
        <input type="checkbox" checked=${editing.enabled}
               onChange=${(e) => setEditing({ ...editing, enabled: e.target.checked })} />
        <span>${editing.enabled ? "включена" : "выключена"}</span>
      </label>
    </div>
    <input value=${editing.name} onInput=${(e) => setEditing({ ...editing, name: e.target.value })} />

    <div class="form-section">
      <div class="form-section-title">
        Условие срабатывания
        <${InfoHint} text="Правило срабатывает, когда алерт соответствует всем указанным условиям. Пустое поле = без ограничения по этому критерию. Хотя бы одно условие обязательно." />
      </div>

      <div class="form-sub">
        <label>
          Алерты
          <${InfoHint} text="Конкретные правила алертов. Пусто = любое правило." />
        </label>
        <${MultiSelect}
          options=${filteredAlertRules.map((ar) => ({
            value: ar.id,
            label: (ar.server_id == null ? "🌐 " : "🖥 ") + ar.name,
          }))}
          selected=${editing.match_rule_ids}
          onChange=${(ids) => setEditing({ ...editing, match_rule_ids: ids })}
          placeholder="все алерты"
          emptyText="нет подходящих правил" />
      </div>

      <div class="form-sub">
        <label>Severity <${InfoHint} text="Критичность алерта. Пусто = любая." /></label>
        <${MultiSelect}
          options=${[
            { value: "critical", label: "critical" },
            { value: "warning", label: "warning" },
            { value: "info", label: "info" },
          ]}
          selected=${editing.match_severities}
          onChange=${(s) => setEditing({ ...editing, match_severities: s })}
          placeholder="любая severity" />
      </div>

      <div class="form-sub">
        <label>Типы условий <${InfoHint} text="Ограничение по типу алерта. Пусто = любое правило. Значения: порог метрики, аномалия детектора, нет данных, проверка операции, провал ручной операции, провал реакции." /></label>
        <${MultiSelect}
          options=${Object.entries(CONDITION_KIND_LABELS).map(([k, label]) => ({
            value: k, label,
          }))}
          selected=${editing.match_condition_kinds}
          onChange=${(s) => setEditing({ ...editing, match_condition_kinds: s })}
          placeholder="любой тип" />
      </div>

      <div class="form-sub">
        <label>Серверы <${InfoHint} text="Ограничение по серверам: реакция сработает только для алертов на этих серверах." /></label>
        <${Radio}
          value=${editing.match_servers_all ? "all" : "specific"}
          onChange=${(v) => setEditing({ ...editing, match_servers_all: v === "all" })}
          options=${[
            { value: "all", label: "Все серверы" },
            { value: "specific", label: "Только выбранные" },
          ]} />
        ${!editing.match_servers_all
          ? html`<${MultiSelect}
              options=${servers.map((s) => ({ value: s.id, label: s.name + " (" + s.llm_alias + ")" }))}
              selected=${editing.match_server_ids}
              onChange=${(ids) => setEditing({ ...editing, match_server_ids: ids })}
              placeholder="выбрать серверы"
              emptyText="нет серверов" />`
          : null}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Действие</div>
      <div class="form-sub">
        <label>Операция</label>
        <select value=${editing.operation_id}
                onChange=${(e) => setEditing({ ...editing, operation_id: e.target.value })}>
          ${ops.map((o) => html`<option value=${o.id}>${o.name} (${o.id})</option>`)}
        </select>
      </div>
      <div class="form-sub">
        <label>Параметры операции (JSON) <${InfoHint} text="У системных операций параметров нет — оставьте {}." /></label>
        <textarea class="mono" rows="4" value=${editing.params}
                  onInput=${(e) => setEditing({ ...editing, params: e.target.value })}></textarea>
      </div>
      <div class="form-sub">
        <label>Сервер запуска</label>
        <select value=${editing.run_on_server}
                onChange=${(e) => setEditing({ ...editing, run_on_server: e.target.value })}>
          <option value="same_as_alert">Тот же, что у алерта</option>
          ${servers.map((s) => html`<option value=${String(s.id)}>${s.name} (${s.llm_alias})</option>`)}
        </select>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Права и подтверждение</div>
      <div class="form-sub">
        <label>Sudo режим</label>
        <${Radio}
          value=${editing.sudo_mode}
          onChange=${(v) => setEditing({ ...editing, sudo_mode: v })}
          options=${[
            { value: "never", label: "never", hint: "— без sudo" },
            { value: "auto", label: "auto", hint: "— автосудо, если активно" },
            { value: "confirm", label: "confirm", hint: "— ждать пароль" },
          ]} />
      </div>
      <div class="form-sub">
        <label>Политика выполнения</label>
        <${Radio}
          value=${editing.action_policy}
          onChange=${(v) => setEditing({ ...editing, action_policy: v })}
          options=${[
            { value: "confirm", label: "confirm", hint: "— ждать подтверждения" },
            { value: "auto", label: "auto", hint: "— запускать сразу" },
          ]} />
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Тайминги</div>
      <div class="row">
        <div style="flex:1">
          <label>Cooldown, сек</label>
          <input type="number" min="0" max="86400" value=${editing.cooldown_sec}
                 onInput=${(e) => setEditing({ ...editing, cooldown_sec: Number(e.target.value) })} />
        </div>
        <div style="flex:1">
          <label>Max попыток на алерт</label>
          <input type="number" min="1" max="20" value=${editing.max_attempts_per_alert}
                 onInput=${(e) => setEditing({ ...editing, max_attempts_per_alert: Number(e.target.value) })} />
        </div>
        <div style="flex:1">
          <label>Max depth</label>
          <input type="number" min="1" max="10" value=${editing.max_depth}
                 onInput=${(e) => setEditing({ ...editing, max_depth: Number(e.target.value) })} />
        </div>
      </div>
    </div>

  </${Modal}>`;
}


function ReactionsView() {
  const [items, setItems] = useState([]);
  const [recent, setRecent] = useState([]);
  const [err, setErr] = useState("");
  const [editorInit, setEditorInit] = useState(null);
  const [detailRid, setDetailRid] = useState(null);

  async function load() {
    setErr("");
    try {
      const [r, rc] = await Promise.all([
        api("/api/v1/reaction-rules"),
        api("/api/v1/reactions?limit=20"),
      ]);
      // Сортировка по имени — стабильный порядок, чтобы карточки
      // не «прыгали» после SSE-обновлений.
      const sortedItems = (r.items || []).slice().sort((a, b) =>
        (a.name || "").localeCompare(b.name || "")
      );
      setItems(sortedItems);
      setRecent(rc.items || []);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      api("/api/v1/reactions?limit=20").then((r) => setRecent(r.items || [])).catch(() => {});
      api("/api/v1/reaction-rules").then((r) => setItems(r.items || [])).catch(() => {});
    }, 10000);
    return () => clearInterval(iv);
  }, []);

  // SSE-канал: любое reaction.* событие — перезагружаем «Последние запуски»
  // почти мгновенно. Мелкий дебаунс 100 мс на случай пачки событий
  // (например, create+finish быстрой реакции).
  useEffect(() => {
    let timer = null;
    const onEv = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const r = await api("/api/v1/reactions?limit=20");
          setRecent(r.items || []);
        } catch {}
      }, 100);
    };
    window.addEventListener("melecho:reaction-event", onEv);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("melecho:reaction-event", onEv);
    };
  }, []);

  function newRule() {
    setEditorInit({ initial: null });
    setErr("");
  }
  function editRule(r) {
    setEditorInit({ initial: reactionRuleToEditorInitial(r) });
    setErr("");
  }

  async function toggle(r) {
    try {
      await api("/api/v1/reaction-rules/" + r.id, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) });
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); }
  }

  async function remove(r) {
    if (!confirm("Удалить правило «" + r.name + "»?")) return;
    try {
      await api("/api/v1/reaction-rules/" + r.id, { method: "DELETE" });
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); }
  }

  return html`<div class="stack">
    ${err ? html`<div class="err">${err}</div>` : null}
    <div class="row">
      <button class="btn" onClick=${newRule}>+ Новое правило</button>
    </div>

    ${items.length === 0
      ? html`<div class="card empty">
          <h3>Правил реакций нет</h3>
          <p class="muted">
            Правило — связка «если алерт подходит под условие → запусти операцию Y».
            Операции state-changing и dangerous всегда требуют подтверждения.
          </p>
        </div>`
      : html`<div class="stack">
          ${items.map((r) => html`<article class=${"check-card " + (!r.enabled ? "disabled" : "")}>
            <div class="check-head">
              <span class=${"badge " + (!r.enabled ? "off" : "ok")}>
                ${r.enabled ? "on" : "off"}
              </span>
              <div class="check-title">${r.name}</div>
              <span class="muted small mono">${r.operation_id}</span>
              <span class=${"rk-policy " + r.action_policy}>
                ${r.action_policy === "auto" ? "auto" : "confirm"}
              </span>
            </div>
            <div class="check-meta">
              ${(r.match && r.match.severities && r.match.severities.length)
                ? html`<span>severity: ${r.match.severities.join(", ")}</span>` : null}
              ${(r.match && r.match.condition_kinds && r.match.condition_kinds.length)
                ? html`<span>тип: ${r.match.condition_kinds.map((k) => conditionKindLabel(k)).join(", ")}</span>`
                : null}
              ${(r.match && r.match.rule_ids && r.match.rule_ids.length)
                ? html`<span>rules: ${r.match.rule_ids.length}</span>` : null}
              ${(r.match && r.match.server_ids && r.match.server_ids.length)
                ? html`<span>servers: ${r.match.server_ids.length}</span>` : null}
              <span>sudo: ${r.sudo_mode}</span>
              <span>cd: ${r.cooldown_sec}s</span>
              <span>max: ${r.max_attempts_per_alert}×</span>
            </div>
            <div class="rk-stats">
              <span>✅ <b>${r.stats ? r.stats.ok : 0}</b></span>
              <span>❌ <b>${r.stats ? r.stats.fail : 0}</b></span>
              <span>⏸ <b>${r.stats ? r.stats.pending : 0}</b></span>
            </div>
            <div class="check-actions">
              <button class="btn btn-sm btn-ghost" onClick=${() => editRule(r)}>Правка</button>
              <button class="btn btn-sm btn-ghost" onClick=${() => toggle(r)}>${r.enabled ? "Отключить" : "Включить"}</button>
              <button class="btn btn-sm btn-danger" onClick=${() => remove(r)}>Удалить</button>
            </div>
          </article>`)}
        </div>`}

    <div class="card stack" style="margin-top:8px">
      <div class="row">
        <h3 class="grow">Последние запуски</h3>
        <span class="muted small">обновляется каждые 20 с</span>
      </div>
      ${recent.length === 0
        ? html`<p class="muted">Запусков ещё не было.</p>`
        : html`<div class="alert-history">
            ${recent.map((r) => html`<div class="alert-history-item" key=${r.id}>
              <${RelStatusBadge} status=${r.status} />
              <span class="mono">
                ${r.operation_id}
                ${r.error_code ? " · " + r.error_code : (r.exit_code != null ? " · exit " + r.exit_code : "")}
              </span>
              <span class="row" style="gap:8px;justify-content:flex-end">
                <span class="alert-history-time">
                  ${r.timestamp_utc}${r.duration_ms != null ? html` · ${r.duration_ms} мс` : null}
                </span>
                <button class="btn btn-sm btn-ghost" onClick=${() => setDetailRid(r.id)}>Детали</button>
              </span>
            </div>`)}
          </div>`}
    </div>

    ${detailRid != null
      ? html`<${ReactionDetailModal} rid=${detailRid} onClose=${() => setDetailRid(null)} />`
      : null}

    ${editorInit
      ? html`<${ReactionRuleEditor}
            initial=${editorInit.initial}
            onClose=${() => setEditorInit(null)}
            onSaved=${async () => { setEditorInit(null); await load(); }} />`
      : null}
  </div>`;
}

const USER_OP_SKELETON = `id: my_op
name: Моя операция
category: other
version: 1
params: []
flags:
  dangerous: false
  state_changing: false
  idempotent: true
  reversible: true
steps:
  - command: "findmnt -J -b -o TARGET,FSTYPE,SIZE,USED,AVAIL"
    expect_exit: 0
`;

function extractYamlId(yaml) {
  const m = /^id:\s*([a-z][a-z0-9_]{0,63})\s*$/m.exec(yaml || "");
  return m ? m[1] : "";
}

function Segmented({ value, onChange, options }) {
  return html`<div class="seg" role="tablist">
    ${options.map((o) => html`<button type="button" key=${o.value}
      class=${"seg-btn " + (value === o.value ? "on" : "")}
      onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

function renderLinksStatus(links, servers) {
  if (!links) return null;
  const ids = links.server_ids || [];
  if (links.is_unbound || (!links.is_global && ids.length === 0)) {
    return html`<span class="badge warn">не привязана</span>`;
  }
  if (links.is_global) {
    return html`<span class="badge">все серверы</span>`;
  }
  const names = ids.map((id) => {
    const s = servers.find((x) => x.id === id);
    return s ? s.name : ("#" + id);
  });
  return html`<span class="badge">${names.join(", ")}</span>`;
}


function ServerPicker({ servers, selected, onChange }) {
  const [filter, setFilter] = useState("");
  const selSet = new Set(selected);
  const q = (filter || "").trim().toLowerCase();
  const visible = q
    ? servers.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        (s.llm_alias || "").toLowerCase().includes(q) ||
        String(s.id) === q,
      )
    : servers;

  function toggle(id) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    onChange([...s]);
  }

  return html`<div class="server-picker">
    <div class="server-picker-chips">
      ${selected.map((id) => {
        const s = servers.find((x) => x.id === id);
        const label = s ? s.name : ("#" + id);
        return html`<span class="wl-chip" key=${id}>
          <span>${label}</span>
          <button type="button" class="wl-chip-x"
                  title="Убрать"
                  onClick=${() => toggle(id)}>×</button>
        </span>`;
      })}
      <input class="server-picker-input" type="text"
             placeholder=${selected.length === 0 ? "добавить серверы…" : "фильтр…"}
             value=${filter}
             onInput=${(e) => setFilter(e.target.value)} />
    </div>
    <div class="server-picker-list">
      ${visible.length === 0
        ? html`<div class="muted small server-picker-empty">Ничего не найдено</div>`
        : visible.map((s) => html`<label class="server-picker-item" key=${s.id}>
            <input type="checkbox" checked=${selSet.has(s.id)}
                   onChange=${() => toggle(s.id)} />
            <span>${s.name}</span>
            <span class="muted small mono">${s.llm_alias}</span>
          </label>`)}
    </div>
  </div>`;
}



// FLIP-анимация сдвига карточек при изменении их порядка.
// Хук возвращает функцию для ref карточек. При каждом рендере с
// изменившимися deps считает разницу позиций и через transform +
// transition плавно сдвигает карточки на новые места.
//
// Зачем не CSS transition на transform в .metric-card: тогда бы
// анимировались ЛЮБЫЕ перерисовки, включая обычную смену окна
// времени. FLIP включает анимацию только когда порядок реально
// изменился.
function useFlip(deps) {
  const refs = useRef(new Map());
  const prev = useRef(new Map());

  useLayoutEffect(() => {
    const next = new Map();
    // offsetTop — не включает transform. getBoundingClientRect включал бы,
    // а мы в предыдущем кадре могли оставить transform → искажение.
    for (const [id, el] of refs.current.entries()) {
      if (el && typeof el.offsetTop === "number") {
        next.set(id, el.offsetTop);
      }
    }
    for (const [id, newTop] of next.entries()) {
      const oldTop = prev.current.get(id);
      if (oldTop == null) continue;
      const dy = oldTop - newTop;
      if (Math.abs(dy) < 1) continue;
      const el = refs.current.get(id);
      if (!el) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.transform = "";
      });
    }
    prev.current = next;
  }, deps);

  return (id) => (el) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };
}


// Контекстное меню счётчика. Открывается правым кликом по карточке
// (позиция от курсора) или кликом по кнопке ⋯ в заголовке (позиция
// от кнопки). Рендерится поверх — fixed-позиционирование, left/top
// через inline style (единственное исключение, кроме .llm-window).
function CounterMenu({
  counter, x, y, currentWindow, globalWindow, cutoffMs,
  onClose, onSetWindow, onHide, onMove, onResetCounter, onToggleValues,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - r.width - 8);
    const maxY = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x: Math.min(x, maxX), y: Math.min(y, maxY) });
  }, [x, y]);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && ref.current.contains(e.target)) return;
      onCloseRef.current();
    }
    function onKey(e) { if (e.key === "Escape") onCloseRef.current(); }
    const t = setTimeout(() => {
      document.addEventListener("pointerdown", onDoc, true);
    }, 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!counter) return null;

  return html`<div ref=${ref}
      class="counter-menu"
      style=${`left: ${pos.x}px; top: ${pos.y}px;`}
      onContextMenu=${(e) => e.preventDefault()}>
    <div class="counter-menu-group">
      <div class="counter-menu-title">Окно времени</div>
      ${["15m", "1h", "24h", "7d"].map((w) => html`<button type="button" key=${w}
          class=${"counter-menu-item " + (currentWindow === w ? "active" : "")}
          onClick=${() => onSetWindow(w)}>
        ${w}${w === globalWindow ? html` <span class="muted small">· общее</span>` : null}
      </button>`)}
      ${currentWindow
        ? html`<button type="button" class="counter-menu-item"
              onClick=${() => onSetWindow(null)}>
            Сбросить к общему (${globalWindow})
          </button>`
        : null}
    </div>
    <div class="counter-menu-sep"></div>
    <div class="counter-menu-group">
      <button type="button" class="counter-menu-item"
              onClick=${() => onMove("up")}>Переместить вверх</button>
      <button type="button" class="counter-menu-item"
              onClick=${() => onMove("down")}>Переместить вниз</button>
    </div>
    <div class="counter-menu-sep"></div>
    <div class="counter-menu-group">
      <button type="button" class="counter-menu-item"
              onClick=${onToggleValues}>
        ${cutoffMs ? "Вернуть значения" : "Сбросить значения"}
      </button>
    </div>
    <div class="counter-menu-sep"></div>
    <div class="counter-menu-group">
      <button type="button" class="counter-menu-item"
              onClick=${onResetCounter}>Сбросить настройки счётчика</button>
    </div>
    <div class="counter-menu-sep"></div>
    <div class="counter-menu-group">
      <button type="button" class="counter-menu-item danger"
              onClick=${onHide}>Скрыть</button>
    </div>
  </div>`;
}


// Панель метрик сервера.
//
// Состояние:
//   order, hidden, windows — настройки отображения (localStorage);
//   cutoffs                 — «сброс значений»: точки старше не
//                              показываем (localStorage);
//   cutoffsSnapshot         — состояние до последнего «сброс всех»,
//                              для toggle «Вернуть значения»;
//   metricSnapshots         — то же для отдельной метрики.
//
// Каждая метрика показывает окно: индивидуальное (windows[id]) или
// глобальное (windowK). Глобальный fetchFetch (за какое окно грузим
// с бэкенда) — max(глобальное, все индивидуальные), считается
// отдельно и передаётся наверх через onFetchWindowChange.
function MetricsView({ serverId }) {
  // ── Layout (persisted) ─────────────────────────────────────
  const [order, setOrder] = useState(() => loadMetricsLayout(serverId).order);
  const [hidden, setHidden] = useState(() => new Set(loadMetricsLayout(serverId).hidden));
  const [windows, setWindows] = useState(() => loadMetricsLayout(serverId).windows);
  const [cutoffs, setCutoffs] = useState(() => loadMetricsCutoff(serverId));
  const [cutoffsSnapshot, setCutoffsSnapshot] = useState(() => loadMetricsCutoffSnapshot(serverId));
  const [metricSnapshots, setMetricSnapshots] = useState({});

  // Глобальное окно. Persist в localStorage.
  const [windowK, setWindowK] = useState(() => loadMetricsGlobalWindow(serverId));

  // ── Данные ─────────────────────────────────────────────────
  // Кэш «окно → {points, net_unit, resolution}». Окна грузятся
  // независимо, кэш не сбрасывается при переключении (вернувшись на
  // 15m, не делаем повторный запрос).
  const [dataByWindow, setDataByWindow] = useState({});
  const inFlightRef = useRef(new Set());
  const [err, setErr] = useState("");

  // ── UI ─────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dragState, setDragState] = useState(null);
  const dragStateRef = useRef(null); dragStateRef.current = dragState;
  const dragRafRef = useRef(null);
  const orderRef = useRef(order); orderRef.current = order;
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden;

  const setCardRef = useFlip([order, hidden, editing]);

  // ── Persistence ────────────────────────────────────────────
  useEffect(() => {
    saveMetricsLayout(serverId, { order, hidden: [...hidden], windows });
  }, [serverId, order, hidden, windows]);
  useEffect(() => { saveMetricsCutoff(serverId, cutoffs); }, [serverId, cutoffs]);
  useEffect(() => { saveMetricsCutoffSnapshot(serverId, cutoffsSnapshot); }, [serverId, cutoffsSnapshot]);
  useEffect(() => { saveMetricsGlobalWindow(serverId, windowK); }, [serverId, windowK]);

  // ── Какие окна нужны ───────────────────────────────────────
  const neededWindows = useMemo(() => {
    const s = new Set([windowK, ...Object.values(windows).filter(Boolean)]);
    return [...s].sort();
  }, [windowK, windows]);
  const neededKey = neededWindows.join(",");
  const neededRef = useRef(neededWindows);
  neededRef.current = neededWindows;

  // ── Fetch ──────────────────────────────────────────────────
  // onlyMissing=true — грузит только окна, которых нет в кэше
  // (переключение 15m→7d→15m не дёргает бэкенд второй раз).
  // onlyMissing=false — перегружает весь набор (SSE, interval).
  async function fetchBatch(onlyMissing) {
    const need = onlyMissing
      ? neededRef.current.filter((w) => !dataByWindow[w] && !inFlightRef.current.has(w))
      : neededRef.current;
    if (need.length === 0) return;
    for (const w of need) inFlightRef.current.add(w);
    try {
      const r = await api(`/api/v1/servers/${serverId}/metrics/batch`, {
        method: "POST",
        body: JSON.stringify({ windows: need }),
      });
      setDataByWindow((prev) => ({ ...prev, ...(r.byWindow || {}) }));
      setErr("");
    } catch (ex) {
      setErr(ex.message);
    } finally {
      for (const w of need) inFlightRef.current.delete(w);
    }
  }

  // Первичная загрузка при смене набора окон.
  useEffect(() => {
    fetchBatch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, neededKey]);

  // SSE: обновляем текущий набор окон при появлении новой точки.
  useEffect(() => {
    let timer = null;
    const onEv = (e) => {
      const p = e && e.detail && e.detail.payload;
      if (!p || p.server_id !== Number(serverId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { fetchBatch(false); }, 400);
    };
    window.addEventListener("melecho:metric-event", onEv);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("melecho:metric-event", onEv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // Страховочный interval на случай разрыва SSE.
  useEffect(() => {
    const iv = setInterval(() => { fetchBatch(false); }, 30000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // ── Drag: listeners на window ──────────────────────────────
  useEffect(() => {
    if (!dragState) return undefined;
    function onMove(e) { onCardPointerMove(e); }
    function onUp(e) { onCardPointerUp(e); }
    function onKey(e) {
      if (e.key === "Escape") {
        if (dragRafRef.current) {
          cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = null;
        }
        setDragState(null);
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("keydown", onKey);
    };
  }, [dragState && dragState.pointerId]);

  // Глобальный cursor: grabbing, пока идёт drag.
  useEffect(() => {
    if (!dragState) return undefined;
    document.body.classList.add("dragging-metric");
    return () => document.body.classList.remove("dragging-metric");
  }, [dragState ? "on" : "off"]);

  // ── Хелперы ────────────────────────────────────────────────
  function isDefaultLayout() {
    if (hidden.size !== 0) return false;
    if (Object.keys(windows).length !== 0) return false;
    if (order.length !== METRICS_COUNTERS.length) return false;
    for (let i = 0; i < order.length; i++) {
      if (order[i] !== METRICS_COUNTERS[i].id) return false;
    }
    return true;
  }
  function openMenu(counterId, x, y) { setMenu({ counterId, x, y }); }
  function hideCounter(id) { setHidden((h) => new Set([...h, id])); setMenu(null); }
  function showAll() { setHidden(new Set()); }

  function setCounterWindow(id, w) {
    if (w === null) {
      setWindows((ws) => { const n = { ...ws }; delete n[id]; return n; });
    } else {
      setWindows((ws) => ({ ...ws, [id]: w }));
    }
    setMenu(null);
  }
  function moveCounter(id, direction) {
    setOrder((o) => {
      const idx = o.indexOf(id);
      if (idx === -1) return o;
      let target = idx;
      if (direction === "up") target = Math.max(0, idx - 1);
      else if (direction === "down") target = Math.min(o.length - 1, idx + 1);
      if (target === idx) return o;
      const next = o.slice();
      next.splice(idx, 1);
      next.splice(target, 0, id);
      return next;
    });
    setMenu(null);
  }
  function resetCounter(id) {
    setHidden((h) => { const n = new Set(h); n.delete(id); return n; });
    setWindows((ws) => { const n = { ...ws }; delete n[id]; return n; });
    setOrder((o) => {
      const defaultOrder = METRICS_COUNTERS.map((c) => c.id);
      const without = o.filter((x) => x !== id);
      const defIdx = defaultOrder.indexOf(id);
      let insertAt = without.length;
      for (let i = defIdx - 1; i >= 0; i--) {
        const prevId = defaultOrder[i];
        const j = without.indexOf(prevId);
        if (j !== -1) { insertAt = j + 1; break; }
      }
      without.splice(insertAt, 0, id);
      return without;
    });
    setMenu(null);
  }
  function resetAll() {
    if (!confirm("Сбросить все настройки отображения метрик?\n\nПорядок, видимость и индивидуальные окна вернутся к дефолту.")) return;
    setOrder(METRICS_COUNTERS.map((c) => c.id));
    setHidden(new Set());
    setWindows({});
    setEditing(false);
  }

  function cutoffKey(id) { return id; }

  // Toggle одной метрики.
  function toggleValues(counterId) {
    const key = cutoffKey(counterId);
    if (cutoffs[key] != null) {
      const prev = metricSnapshots[key];
      setCutoffs((c) => {
        const next = { ...c };
        if (prev == null) delete next[key]; else next[key] = prev;
        return next;
      });
      setMetricSnapshots((m) => { const n = { ...m }; delete n[key]; return n; });
    } else {
      const now = Date.now();
      setMetricSnapshots((m) => ({ ...m, [key]: cutoffs[key] ?? null }));
      setCutoffs((c) => ({ ...c, [key]: now }));
    }
    setMenu(null);
  }

  // Toggle всех видимых.
  function toggleAllValues() {
    const keys = visibleCounters.map((c) => cutoffKey(c.id));
    if (keys.length === 0) return;
    const allHave = keys.every((k) => cutoffs[k] != null);
    if (allHave) {
      const snap = cutoffsSnapshot || {};
      setCutoffs((c) => {
        const next = { ...c };
        for (const k of keys) {
          if (snap[k] != null) next[k] = snap[k]; else delete next[k];
        }
        return next;
      });
      setCutoffsSnapshot(null);
      setMetricSnapshots({});
    } else {
      setCutoffsSnapshot({ ...cutoffs });
      const now = Date.now();
      setCutoffs((c) => {
        const next = { ...c };
        for (const k of keys) next[k] = now;
        return next;
      });
      setMetricSnapshots({});
    }
  }

  // ── Drag logic ─────────────────────────────────────────────
  function onCardPointerDown(e, id, index) {
    if (!editing) return;
    if (e.button !== 0) return;
    if (e.target.closest("button, input, select, textarea")) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    setDragState({
      id, pointerId: e.pointerId, startY: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      ghostW: rect.width, ghostH: rect.height,
      cursorX: e.clientX, cursorY: e.clientY,
    });
    e.preventDefault();
  }
  function computeTargetIndex(cursorY, draggedId, visibleIds) {
    const without = visibleIds.filter((id) => id !== draggedId);
    for (let i = 0; i < without.length; i++) {
      const el = document.querySelector(`[data-metric-id="${without[i]}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (cursorY < r.top + r.height / 2) return i;
    }
    return without.length;
  }
  function applyOrderChange(draggedId, visibleOrder) {
    setOrder((o) => {
      const hiddenSet = new Set(o.filter((id) => !visibleOrder.includes(id) && id !== draggedId));
      const without = o.filter((id) => id !== draggedId);
      const targetIndex = visibleOrder.indexOf(draggedId);
      const result = [];
      let seenVisible = 0;
      let inserted = false;
      for (const id of without) {
        if (hiddenSet.has(id)) { result.push(id); continue; }
        if (!inserted && seenVisible === targetIndex) {
          result.push(draggedId); inserted = true;
        }
        result.push(id); seenVisible++;
      }
      if (!inserted) result.push(draggedId);
      return result;
    });
  }
  function onCardPointerMove(e) {
    const s = dragStateRef.current;
    if (!s) return;
    if (e.pointerId !== s.pointerId) return;
    const { clientX, clientY } = e;
    setDragState((prev) => prev ? { ...prev, cursorX: clientX, cursorY: clientY } : null);
    if (dragRafRef.current) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const cur = dragStateRef.current;
      if (!cur) return;
      const visibleIds = orderRef.current.filter((id) => !hiddenRef.current.has(id));
      const targetIdx = computeTargetIndex(cur.cursorY, cur.id, visibleIds);
      const without = visibleIds.filter((id) => id !== cur.id);
      const newVisible = without.slice();
      newVisible.splice(targetIdx, 0, cur.id);
      if (visibleIds.join(",") === newVisible.join(",")) return;
      applyOrderChange(cur.id, newVisible);
    });
  }
  function onCardPointerUp(e) {
    const s = dragStateRef.current;
    if (!s) return;
    if (e.pointerId !== s.pointerId) return;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    setDragState(null);
  }

  // ── Видимые и их данные ────────────────────────────────────
  const visibleIds = useMemo(
    () => order.filter((id) => !hidden.has(id)),
    [order, hidden],
  );
  const visibleCounters = useMemo(
    () => visibleIds.map((id) => METRICS_COUNTERS.find((c) => c.id === id)).filter(Boolean),
    [visibleIds],
  );

  // Точки для каждой метрики. effectiveWindow = windows[id] || windowK.
  // Данные берём из dataByWindow[effectiveWindow], при cutoff —
  // фильтруем. Пока окно ещё не загружено — points: null,
  // в рендере отрисуется «Загрузка…».
  const filteredPointsByCounter = useMemo(() => {
    const map = new Map();
    for (const c of visibleCounters) {
      const customWindow = windows[c.id] || null;
      const effectiveWindow = customWindow || windowK;
      const cutoffMs = cutoffs[c.id] || null;
      const wd = dataByWindow[effectiveWindow];
      if (!wd) {
        map.set(c.id, { points: null, netUnit: "bytes_cumulative" });
      } else if (!cutoffMs) {
        map.set(c.id, { points: wd.points, netUnit: wd.net_unit });
      } else {
        map.set(c.id, {
          points: filterPointsForMetric(wd.points, null, cutoffMs),
          netUnit: wd.net_unit,
        });
      }
    }
    return map;
  }, [dataByWindow, windows, cutoffs, serverId, visibleCounters, windowK]);

  const hiddenCount = hidden.size;
  const isDefault = isDefaultLayout();
  const allHaveCutoff = visibleCounters.length > 0
    && visibleCounters.every((c) => cutoffs[cutoffKey(c.id)] != null);

  return html`<div class="stack">
    ${err ? html`<p class="err">${err}</p>` : null}
    <div class="metrics-toolbar">
      <div class="metrics-windows">
        ${["15m", "1h", "24h", "7d"].map((w) => html`<button
            key=${w}
            class=${"btn btn-sm " + (windowK === w ? "btn-primary" : "")}
            onClick=${() => setWindowK(w)}>${w}</button>`)}
      </div>
      ${editing
        ? html`<span class="muted small">Перетащите карточки в нужном порядке</span>`
        : null}
      <div class="grow"></div>
      ${hiddenCount > 0
        ? html`<button class="btn btn-sm btn-ghost" onClick=${showAll}>
            Показать все (${hiddenCount})
          </button>`
        : null}
      ${visibleCounters.length > 0
        ? html`<button class="btn btn-sm btn-ghost metrics-reset"
              title=${allHaveCutoff
                ? "Вернуть все значения метрик, как было до сброса"
                : "Начать строить все графики заново с текущего момента"}
              onClick=${toggleAllValues}>
            ${allHaveCutoff ? "Вернуть значения" : "Сбросить значения"}
          </button>`
        : null}
      <button class=${"btn btn-sm " + (editing ? "btn-primary" : "btn-ghost")}
              onClick=${() => setEditing((v) => !v)}>
        ${editing ? "Готово" : "Редактировать"}
      </button>
      ${editing
        ? html`<button class="btn btn-sm btn-ghost metrics-reset"
              disabled=${isDefault}
              title=${isDefault
                ? "Настройки в дефолтном состоянии"
                : "Вернуть порядок, видимость и окна к дефолту"}
              onClick=${resetAll}>
            Сбросить все
          </button>`
        : null}
    </div>

    ${visibleCounters.length === 0
      ? html`<div class="card empty">
          <h3>Все счётчики скрыты</h3>
          <p class="muted">Нажмите «Показать все», чтобы вернуть их.</p>
        </div>`
      : html`<div class=${"metrics-grid" + (editing ? " editing" : "")}>
          ${visibleCounters.map((c, index) => {
            const customWindow = windows[c.id] || null;
            const cutoffMs = cutoffs[cutoffKey(c.id)] || null;
            const entry = filteredPointsByCounter.get(c.id) || { points: null, netUnit: "bytes_cumulative" };
            const isLoading = entry.points == null;
            const isDragged = dragState && dragState.id === c.id;
            return html`<article key=${c.id}
                data-metric-id=${c.id}
                ref=${setCardRef(c.id)}
                class=${"metric-card" + (isDragged ? " dragging" : "")}
                onContextMenu=${(e) => {
                  e.preventDefault();
                  openMenu(c.id, e.clientX, e.clientY);
                }}
                onPointerDown=${editing ? (e) => onCardPointerDown(e, c.id, index) : null}>
              <div class="metric-head">
                <span class="metric-drag" aria-hidden="true">⠿</span>
                <h3 class="metric-title">${c.label}</h3>
                ${customWindow
                  ? html`<span class="metric-window-badge">${customWindow}</span>`
                  : null}
                ${cutoffMs
                  ? html`<span class="metric-cutoff-badge"
                          title=${"Значения сброшены: показывается история с " + new Date(cutoffMs).toLocaleString()}>
                      ⟲
                    </span>`
                  : null}
                <button type="button" class="metric-menu-btn"
                        title="Действия"
                        onPointerDown=${(e) => e.stopPropagation()}
                        onClick=${(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          openMenu(c.id, r.right, r.bottom + 4);
                        }}>⋯</button>
              </div>
              ${editing
                ? html`<div class="metric-edit-info muted small">
                    ${index + 1} из ${visibleCounters.length}
                  </div>`
                : html`<div class="metric-chart">
                    ${isLoading
                      ? html`<div class="metric-chart-placeholder">Загрузка…</div>`
                      : c.render(entry.points, entry.netUnit)}
                  </div>`}
            </article>`;
          })}
        </div>`}

    ${menu
      ? html`<${CounterMenu}
          counter=${METRICS_COUNTERS.find((c) => c.id === menu.counterId)}
          x=${menu.x} y=${menu.y}
          currentWindow=${windows[menu.counterId] || null}
          globalWindow=${windowK}
          cutoffMs=${cutoffs[cutoffKey(menu.counterId)] || null}
          onClose=${() => setMenu(null)}
          onSetWindow=${(w) => setCounterWindow(menu.counterId, w)}
          onHide=${() => hideCounter(menu.counterId)}
          onMove=${(dir) => moveCounter(menu.counterId, dir)}
          onResetCounter=${() => resetCounter(menu.counterId)}
          onToggleValues=${() => toggleValues(menu.counterId)}
        />`
      : null}

    ${dragState
      ? (() => {
          const c = METRICS_COUNTERS.find((x) => x.id === dragState.id);
          if (!c) return null;
          const left = dragState.cursorX - dragState.offsetX;
          const top = dragState.cursorY - dragState.offsetY;
          return html`<div class="metric-card-ghost"
              style=${`left: ${left}px; top: ${top}px; width: ${dragState.ghostW}px;`}>
            <div class="metric-head">
              <span class="metric-drag" aria-hidden="true">⠿</span>
              <h3 class="metric-title">${c.label}</h3>
            </div>
          </div>`;
        })()
      : null}
  </div>`;
}

function SymBtn({ symbol, tooltip, onClick, onContextMenu, disabled, send }) {
  const [tipVisible, setTipVisible] = useState(false);
  const btnRef = useRef(null);
  const timerRef = useRef(null);

  function show() {
    if (disabled) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setTipVisible(true), 1000);
  }
  function hide() {
    clearTimeout(timerRef.current);
    setTipVisible(false);
  }
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Тултип рендерится в document.body: CSS-::after не вылезет за .modal
  // с overflow: hidden, а position: fixed внутри .modal тоже сломан —
  // у .modal есть animation с transform, который создаёт containing block
  // для fixed. Портал в body — единственный надёжный способ.
  useEffect(() => {
    if (!tipVisible || !btnRef.current) return undefined;
    const r = btnRef.current.getBoundingClientRect();
    const el = document.createElement("div");
    el.className = "tooltip-float";
    el.textContent = tooltip;
    el.style.top = (r.top - 6) + "px";
    el.style.left = (r.left + r.width / 2) + "px";
    document.body.appendChild(el);
    return () => { el.remove(); };
  }, [tipVisible, tooltip]);

  const cls = "sym-btn" + (send ? " sym-btn-send" : "");
  return html`<button ref=${btnRef} type="button" class=${cls}
      disabled=${disabled}
      onPointerEnter=${show} onPointerLeave=${hide}
      onContextMenu=${onContextMenu}
      onClick=${onClick}>${symbol}</button>`;
}


function UserOpEditor({ mode, oid, initialYaml, onClose, onSaved }) {
  const isCreate = mode === "create";
  const [yaml, setYaml] = useState(initialYaml || (isCreate ? USER_OP_SKELETON : ""));
  const [loading, setLoading] = useState(!isCreate);
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [servers, setServers] = useState([]);
  const [linksMode, setLinksMode] = useState("unbound");
  const [serverIds, setServerIds] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const tasks = [api("/api/v1/servers")];
        if (!isCreate) {
          tasks.push(api("/api/v1/operations/user/" + encodeURIComponent(oid)));
          tasks.push(api("/api/v1/operations/" + encodeURIComponent("user:" + oid) + "/links"));
        }
        const [srv, opR, linksR] = await Promise.all(tasks);
        setServers(srv.items || []);
        if (!isCreate) {
          setYaml(opR.yaml || "");
          if (linksR.is_unbound) setLinksMode("unbound");
          else if (linksR.is_global) setLinksMode("global");
          else { setLinksMode("specific"); setServerIds(linksR.server_ids || []); }
        }
      } catch (ex) {
        setErr(ex.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [mode, oid]);

  useEffect(() => {
    if (loading || !yaml.trim()) {
      setValidation(null);
      return undefined;
    }
    const t = setTimeout(async () => {
      setValidating(true);
      try {
        const r = await api("/api/v1/operations/user/validate", {
          method: "POST",
          body: JSON.stringify({ id: extractYamlId(yaml), yaml }),
        });
        setValidation(r);
      } catch (ex) {
        setValidation({ valid: false, error: ex.message });
      } finally {
        setValidating(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [yaml, loading]);

  async function save() {
    if (!validation || !validation.valid) {
      setErr("есть ошибки валидации — исправьте YAML");
      return;
    }
    const id = extractYamlId(yaml);
    if (!id) {
      setErr("в YAML нет валидного поля id");
      return;
    }
    setBusy(true); setErr("");
    const linksBody = linksMode === "global"
      ? { is_global: true, server_ids: [] }
      : { is_global: false, server_ids: linksMode === "unbound" ? [] : serverIds };
    try {
      if (isCreate) {
        await api("/api/v1/operations/user", {
          method: "POST",
          body: JSON.stringify({ id, yaml }),
        });
        if (linksMode !== "unbound") {
          try {
            await api(
              "/api/v1/operations/" + encodeURIComponent("user:" + id) + "/links",
              { method: "PUT", body: JSON.stringify(linksBody) },
            );
          } catch (ex) {
            // Не оставляем unbound-операцию на диске при провале привязки.
            try { await api("/api/v1/operations/user/" + encodeURIComponent(id), { method: "DELETE" }); } catch {}
            throw ex;
          }
        }
      } else {
        await api("/api/v1/operations/user/" + encodeURIComponent(oid), {
          method: "PATCH",
          body: JSON.stringify({ yaml }),
        });
        await api(
          "/api/v1/operations/" + encodeURIComponent("user:" + oid) + "/links",
          { method: "PUT", body: JSON.stringify(linksBody) },
        );
      }
      showToast(isCreate ? "Операция создана" : "Операция сохранена", "ok");
      onSaved && onSaved();
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Удалить операцию «" + oid + "»?")) return;
    setBusy(true); setErr("");
    try {
      await api("/api/v1/operations/user/" + encodeURIComponent(oid), { method: "DELETE" });
      onSaved && onSaved();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  function exportToLLM() {
    const id = extractYamlId(yaml);
    // Шлём YAML как вложение (плашка над полем ввода LLM-чата).
    // Если есть ошибка валидации — прикрепляем её отдельным комментарием,
    // чтобы пользователь видел, о чём просить LLM.
    const comment = (validation && !validation.valid && validation.error)
      ? ("Ошибка валидации: " + validation.error)
      : "";
    window.dispatchEvent(new CustomEvent("melecho:llm-attach", {
      detail: {
        name: "yaml: " + (id || "operation"),
        content: yaml.trim() + (comment ? "\n\n# " + comment : ""),
      },
    }));
  }

  const canSave = !busy && validation && validation.valid;
  const title = isCreate ? "Новая операция" : ("Операция: " + oid);

  return html`<${Modal} title=${title} onClose=${onClose}
    footer=${html`<div class="row grow">
      ${!isCreate
        ? html`<button class="btn btn-sm btn-danger" disabled=${busy} onClick=${remove}>Удалить</button>`
        : null}
      <div class="grow"></div>
      <button class="btn btn-sm btn-ghost" onClick=${onClose}>Отмена</button>
      <button class="btn btn-sm btn-primary" disabled=${!canSave} onClick=${save}>
        ${busy ? "Сохранение…" : "Сохранить"}
      </button>
    </div>`}>
    <p class="muted small">
      Операция — параметризованный argv. Голова команды должна быть в белом
      списке каталога. Запрещены интерпретаторы, метасимволы и абсолютные пути.
    </p>
    ${loading
      ? html`<p class="muted">Загрузка…</p>`
      : html`<div class="user-op-yaml-wrap">
          <textarea class="mono user-op-yaml" spellCheck=${false}
                    value=${yaml}
                    onInput=${(e) => {
                      setYaml(e.target.value);
                      setValidation(null);
                      setErr("");
                    }}></textarea>
          <${SymBtn} symbol="↗" tooltip="Передать в LLM-чат"
              disabled=${busy || !yaml.trim()}
              onClick=${exportToLLM} />
        </div>`}
    <div class="row user-op-status">
      ${validating
        ? html`<span class="muted small">Проверка…</span>`
        : validation == null
        ? html`<span class="muted small">${yaml.trim() ? "Проверка…" : "Введите YAML"}</span>`
        : validation.valid
        ? html`<span class="okt small">✓ Валидно</span>
               ${validation.parsed ? html`<span class="muted small">· ${validation.parsed.name}</span>` : null}`
        : html`<span class="err small">✗ ${validation.error || "невалидно"}</span>`}
    </div>

    <div class="form-section">
      <div class="form-section-title">Привязка к серверам</div>
      <${Segmented}
        value=${linksMode}
        onChange=${setLinksMode}
        options=${[
          { value: "unbound", label: "Не привязана" },
          { value: "global", label: "Все серверы" },
          { value: "specific", label: "Выбрать серверы" },
        ]} />
      ${linksMode === "specific"
        ? (servers.length === 0
            ? html`<div class="muted small">Серверов пока нет.</div>`
            : html`<${ServerPicker}
                servers=${servers}
                selected=${serverIds}
                onChange=${setServerIds} />`)
        : null}
    </div>

    ${err && (!validation || validation.valid)
      ? html`<div class="err">${err}</div>`
      : null}
  </${Modal}>`;
}


function WhitelistEditor({ onClose }) {
  const [data, setData] = useState(null);
  const [newCmd, setNewCmd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr("");
    try {
      const r = await api("/api/v1/catalog/whitelist");
      setData(r);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  async function add() {
    const cmd = newCmd.trim();
    if (!cmd || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await api("/api/v1/catalog/whitelist", {
        method: "POST",
        body: JSON.stringify({ cmd }),
      });
      setData(r);
      setNewCmd("");
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function remove(cmd) {
    if (!confirm("Убрать команду «" + cmd + "» из белого списка?\n\nОперации, которые её используют, станут невалидными.")) return;
    setBusy(true); setErr("");
    try {
      const r = await api("/api/v1/catalog/whitelist/" + encodeURIComponent(cmd), {
        method: "DELETE",
      });
      setData(r);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  return html`<${Modal} title="Белый список команд" onClose=${onClose}
    footer=${html`<div class="row">
      <span class="muted small grow">
        Расширение белого списка разрешает использовать новую команду
        в user-операциях. Базовые команды (config.toml) сюда добавлять не нужно.
      </span>
      <button class="btn btn-sm btn-ghost" onClick=${onClose}>Закрыть</button>
    </div>`}>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${!data
      ? html`<p class="muted">Загрузка…</p>`
      : html`<div class="stack">
          <div class="form-sub">
            <label>Добавить команду</label>
            <div class="row">
              <input class="mono grow" placeholder="например wg" value=${newCmd}
                     disabled=${busy}
                     onInput=${(e) => setNewCmd(e.target.value)}
                     onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
              <button class="btn btn-sm btn-primary"
                      disabled=${busy || !newCmd.trim()}
                      onClick=${add}>${busy ? "…" : "Добавить"}</button>
            </div>
            <span class="muted small">
              Имя: буквы, цифры, <span class="mono">.</span>,
              <span class="mono">_</span>, <span class="mono">+</span>,
              <span class="mono">-</span>; до 64 символов. Интерпретаторы
              (sh, awk, sed, …) отклоняются автоматически.
            </span>
          </div>

          <div class="form-sub">
            <label>Добавленные <span class="muted small">(${data.commands.length})</span></label>
            ${data.commands.length === 0
              ? html`<div class="muted small">Пока пусто — валидатор работает только с базовым списком.</div>`
              : html`<div class="wl-chips">
                  ${data.commands.map((c) => html`<span class="wl-chip" key=${c}>
                    <span class="mono">${c}</span>
                    <button type="button" class="wl-chip-x" disabled=${busy}
                            title="Убрать из белого списка"
                            onClick=${() => remove(c)}>×</button>
                  </span>`)}
                </div>`}
          </div>

          <details>
            <summary class="muted small">
              Базовые команды (${data.base.length}) — из config.toml
            </summary>
            <div class="wl-chips" style="padding-top:8px">
              ${data.base.map((c) => html`<span class="wl-chip base mono" key=${c}>${c}</span>`)}
            </div>
          </details>

          <div class="muted small">
            Эффективный список (<span class="mono">${data.effective.length}</span>):
            <span class="mono">${data.effective.join(", ")}</span>
          </div>
        </div>`}
  </${Modal}>`;
}


function UserOpsView() {
  const [items, setItems] = useState([]);
  const [servers, setServers] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [whitelistOpen, setWhitelistOpen] = useState(false);

  async function load() {
    setErr("");
    try {
      const [ops, srv] = await Promise.all([
        api("/api/v1/operations/user"),
        api("/api/v1/servers"),
      ]);
      setItems((ops.items || []).slice().sort((a, b) =>
        (a.name || "").localeCompare(b.name || "")
      ));
      setServers(srv.items || []);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  async function remove(op) {
    if (!confirm("Удалить операцию «" + op.name + "»? Ссылки на неё в проверках и реакциях станут битыми.")) return;
    setBusy(true); setErr("");
    try {
      const clean = op.id.startsWith("user:") ? op.id.slice(5) : op.id;
      await api("/api/v1/operations/user/" + encodeURIComponent(clean), { method: "DELETE" });
      await load();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  return html`<div class="stack">
    ${err ? html`<div class="err">${err}</div>` : null}
    <div class="row">
      <button class="btn" onClick=${() => setEditing({ mode: "create" })}>+ Новая операция</button>
      <button class="btn btn-ghost" onClick=${() => setWhitelistOpen(true)}>Белый список команд</button>
      <span class="muted small grow">
        Операции описываются YAML-файлами в
        <span class="mono">~/.local/share/melecho/catalog.d/</span>.
        Голова команды должна быть в белом списке каталога.
      </span>
    </div>
    ${items.length === 0
      ? html`<div class="card empty">
          <h3>Пользовательских операций нет</h3>
          <p class="muted">
            Операция — это параметризованный argv, который выполняется
            на сервере без shell-интерпретатора. Создайте её вручную или
            попросите LLM сгенерировать черновик.
          </p>
        </div>`
      : html`<div class="stack">
          ${items.map((op) => html`<article class="check-card" key=${op.id}>
            <div class="check-head">
              <span class=${"badge " + (op.valid ? "ok" : "fail")}>
                ${op.valid ? "ok" : "invalid"}
              </span>
              <div class="check-title">${op.name}</div>
              <span class="muted small mono">${op.id}</span>
            </div>
            <div class="check-meta">
              <span>${op.category || "other"}</span>
              ${renderLinksStatus(op.links, servers)}
              ${op.flags && op.flags.state_changing ? html`<span>state-changing</span>` : null}
              ${op.flags && op.flags.dangerous ? html`<span>dangerous</span>` : null}
            </div>
            ${!op.valid && op.error
              ? html`<div class="err">${op.error}</div>`
              : null}
            <div class="check-actions">
              <button class="btn btn-sm" onClick=${() => { const clean = op.id.startsWith("user:") ? op.id.slice(5) : op.id; setEditing({ mode: "edit", oid: clean }); }}>Правка</button>
              <button class="btn btn-sm btn-danger" disabled=${busy} onClick=${() => remove(op)}>Удалить</button>
            </div>
          </article>`)}
        </div>`}
    ${editing
      ? html`<${UserOpEditor}
            mode=${editing.mode}
            oid=${editing.oid || null}
            onClose=${() => setEditing(null)}
            onSaved=${async () => { setEditing(null); await load(); }} />`
      : null}
    ${whitelistOpen
      ? html`<${WhitelistEditor} onClose=${() => setWhitelistOpen(false)} />`
      : null}
  </div>`;
}


function AutomationView({ autoState, pendingCount, onOpenPending, onRefreshStatus, initialRuleRid, onRuleDetailClosed }) {
  const [sub, setSub] = useState("reactions");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Внешний запрос открыть детальную конкретного правила — например,
  // пользователь кликнул «Правило #N» в AlertDetailModal.
  useEffect(() => {
    if (initialRuleRid != null) setSub("alert_rules");
  }, [initialRuleRid]);

  const stopped = !!(autoState && autoState.stopped);

  async function stopAll() {
    if (!confirm("Остановить все автоматические реакции? Правила будут выключены, текущие running — продолжатся.")) return;
    setBusy(true); setErr("");
    try {
      await api("/api/v1/automation/stop-all", { method: "POST", body: "{}" });
      onRefreshStatus && onRefreshStatus();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  async function resumeAll() {
    setBusy(true); setErr("");
    try {
      await api("/api/v1/automation/resume-all", { method: "POST", body: "{}" });
      onRefreshStatus && onRefreshStatus();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  return html`<div class="page">
    <div class="srv-head">
      <div>
        <h2 class="h2">Автоматизация</h2>
        <p class="muted">Периодические проверки серверов и автоматические реакции на алерты.</p>
      </div>
      ${!stopped
        ? html`<button class="btn btn-sm btn-danger" disabled=${busy} onClick=${stopAll}>
            Остановить автоматизацию
          </button>`
        : null}
    </div>
    ${err ? html`<p class="err">${err}</p>` : null}
    ${stopped
      ? html`<div class="banner danger">
          <div class="row">
            <span class="grow">
              <b>Автоматические реакции остановлены</b>
              ${autoState.stopped_at ? html` · ${autoState.stopped_at}` : null}
              ${autoState.disabled_rule_ids && autoState.disabled_rule_ids.length
                ? html` · отключено правил: ${autoState.disabled_rule_ids.length}`
                : null}
            </span>
            <button class="btn btn-sm btn-primary" disabled=${busy} onClick=${resumeAll}>
              Возобновить
            </button>
          </div>
        </div>`
      : null}
    ${!stopped && pendingCount > 0
      ? html`<div class="banner warn">
          <div class="row">
            <span class="grow"><b>${pendingCount} реакций ожидают подтверждения</b></span>
            <button class="btn btn-sm" onClick=${() => onOpenPending && onOpenPending()}>
              Открыть очередь
            </button>
          </div>
        </div>`
      : null}
    <div class="sub-tabs">
      <button class=${sub === "reactions" ? "on" : ""} onClick=${() => setSub("reactions")}>Реакции</button>
      <button class=${sub === "operations" ? "on" : ""} onClick=${() => setSub("operations")}>Операции</button>
      <button class=${sub === "alert_rules" ? "on" : ""} onClick=${() => setSub("alert_rules")}>Правила</button>
    </div>
    ${sub === "reactions" ? html`<${ReactionsView} />` : null}
    ${sub === "operations" ? html`<${UserOpsView} />` : null}
    ${sub === "alert_rules" ? html`<${AlertRulesView}
        initialDetailRid=${initialRuleRid}
        onDetailClosed=${onRuleDetailClosed} />` : null}
  </div>`;
}
function SettingsView() {
  const [s, setS] = useState(null);
  const [anoms, setAnoms] = useState([]);
  const [llmRows, setLlmRows] = useState([]);
  // Настройка хранится в localStorage; дублируется в state, чтобы
  // чекбокс перерисовывался при переключении.
  const [smoothStream, setSmoothStream] = useState(() => llmSmoothEnabled());
  // Хост/порт для проверки доступа в интернет. Черновик полей —
  // сохраняется по кнопке. Синхронизируется из s.* по useEffect.
  const [netDraft, setNetDraft] = useState({ host: "", port: 53 });
  const [netBusy, setNetBusy] = useState(false);
  const [netErr, setNetErr] = useState("");
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [desktopInstalled, setDesktopInstalled] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [updateErr, setUpdateErr] = useState("");
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  useEffect(() => {
    api("/api/v1/settings").then(setS);
    api("/api/v1/llm/anomalies").then((r) => setAnoms(r.items || []));
    api("/api/v1/llm/audit").then((r) => setLlmRows(r.items || []));
    api("/api/v1/system/update-status").then(setUpdateStatus).catch(() => {});
    api("/api/v1/system/desktop-status").then(r => setDesktopInstalled(r.installed)).catch(() => {});
  }, []);

  useEffect(() => {
    function onUpdateAvail(ev) {
      const d = (ev && ev.detail && ev.detail.payload) || {};
      setUpdateStatus((prev) => prev ? {
        ...prev,
        available: d.available !== undefined ? d.available : prev.available,
        checking: !!d.checking,
        error: d.error !== undefined ? d.error : prev.error,
        last_check_at: d.last_check_at || prev.last_check_at,
      } : prev);
    }
    window.addEventListener("melecho:update-event", onUpdateAvail);
    return () => window.removeEventListener("melecho:update-event", onUpdateAvail);
  }, []);

  useEffect(() => {
    function onScrollTo() {
      const el = document.getElementById("settings-updates-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.addEventListener("melecho:scroll-to-updates", onScrollTo);
    return () => window.removeEventListener("melecho:scroll-to-updates", onScrollTo);
  }, []);
  if (!s) return html`<div class="page">…</div>`;
  async function toggleLlm(v) {
    setS(await api("/api/v1/settings", { method: "PATCH", body: JSON.stringify({ llm_master_enabled: v }) }));
    // AppShell держит status отдельно; пусть перечитает — тогда окно LLM
    // появится/исчезнет без ручной перезагрузки страницы.
    window.dispatchEvent(new Event("melecho:refresh-status"));
  }
  async function toggleOptIn(v) {
    setS(await api("/api/v1/settings", { method: "PATCH", body: JSON.stringify({ llm_opt_in_logs: v }) }));
  }
  function toggleSmooth(v) {
    setLLMSmoothEnabled(v);
    setSmoothStream(v);
  }
  async function saveTtl(ev) {
    ev.preventDefault();
    const v = Number(new FormData(ev.target).get("ttl"));
    setS(await api("/api/v1/settings", { method: "PATCH", body: JSON.stringify({ sudo_ttl_sec: v }) }));
  }

  // Синхронизация netDraft из s.* при появлении s (первая загрузка)
  // и после каждого сохранения (s обновляется из ответа PATCH).
  // Зависимости — конкретные поля: другие обновления s (например,
  // после смены llm_master) не будут перезаписывать введённые значения.
  useEffect(() => {
    if (!s) return;
    setNetDraft({
      host: s.internet_check_host || "",
      port: s.internet_check_port || 53,
    });
  }, [s && s.internet_check_host, s && s.internet_check_port]);

  async function refreshUpdateStatus() {
    try {
      const r = await api("/api/v1/system/update-status");
      setUpdateStatus(r);
    } catch (ex) {
      setUpdateErr(ex.message);
    }
  }

  async function toggleAutoCheck(next) {
    setUpdateErr("");
    try {
      const r = await api("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({ updates_check_on_start: !!next }),
      });
      setS(r);
      await refreshUpdateStatus();
    } catch (ex) {
      setUpdateErr(ex.message);
    }
  }

  async function checkUpdatesNow() {
    setUpdateBusy(true);
    setUpdateErr("");
    try {
      const r = await api("/api/v1/system/check-updates", {
        method: "POST", body: "{}",
      });
      setUpdateStatus(r);
    } catch (ex) {
      setUpdateErr(ex.message);
    } finally {
      setUpdateBusy(false);
    }
  }

  async function doApplyUpdate() {
    setUpdateConfirmOpen(false);
    setUpdateBusy(true);
    setUpdateErr("");
    try {
      const r = await api("/api/v1/system/apply-update", {
        method: "POST", body: "{}",
      });
      if (!r || !r.ok) {
        setUpdateErr(r && r.message ? r.message : "apply failed");
        setUpdateBusy(false);
        return;
      }
      // Успех. Бэкенд запланировал graceful shutdown (1–2 секунды):
      // следующий polling уже получит connection refused. Переключаем
      // Root в phase=stopped сразу, не дожидаясь тишины в сети и не
      // оставляя вкладку с вечным «Обновляю…».
      sessionToken = "";
      try { sessionStorage.removeItem("melecho.session"); } catch {}
      window.dispatchEvent(new CustomEvent("melecho:backend-stopped"));
    } catch (ex) {
      setUpdateErr(ex.message);
      setUpdateBusy(false);
    }
  }

  async function toggleDesktop(next) {
    if (desktopBusy) return;
    const prev = desktopInstalled;
    // Оптимистичное обновление: toggle визуально переключается сразу.
    // Если backend ответит ошибкой — откатим.
    setDesktopInstalled(next);
    setDesktopBusy(true);
    try {
      const endpoint = next
        ? "/api/v1/system/install-desktop"
        : "/api/v1/system/uninstall-desktop";
      await api(endpoint, { method: "POST", body: "{}" });
      showToast(next ? "Ярлык создан" : "Ярлык удалён", "ok");
    } catch (ex) {
      setDesktopInstalled(prev);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setDesktopBusy(false);
    }
  }

  async function saveNet() {
    setNetBusy(true);
    setNetErr("");
    try {
      const body = {
        internet_check_host: (netDraft.host || "").trim(),
        internet_check_port: Number(netDraft.port) || 53,
      };
      const r = await api("/api/v1/settings", {
        method: "PATCH", body: JSON.stringify(body),
      });
      setS(r);
      showToast("Настройки сети сохранены", "ok");
    } catch (ex) {
      setNetErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setNetBusy(false);
    }
  }

  return html`<div class="page stack">
    <h2 class="h2">Настройки</h2>
    <div class="card stack">
      <h3>Общие</h3>
      <label class="check"><input type="checkbox" checked=${s.llm_master_enabled} onChange=${(e) => toggleLlm(e.target.checked)} /> Мастер переключатель LLM (отключение/включение AI функций)</label>
      <label class="check"><input type="checkbox" checked=${!!s.llm_opt_in_logs} onChange=${(e) => toggleOptIn(e.target.checked)} /> Opt-in: сырые логи в LLM (ответ не кэшируется)</label>
      <label class="check"><input type="checkbox" checked=${smoothStream} onChange=${(e) => toggleSmooth(e.target.checked)} /> Плавный стрим ответов LLM</label>
      <label class="check check--onoff"
             title=${desktopBusy
               ? "Обработка…"
               : (desktopInstalled
                   ? "Удалить ярлык из меню приложений"
                   : "Создать ярлык в меню приложений для быстрого запуска")}>
        <input type="checkbox" checked=${desktopInstalled}
               disabled=${desktopBusy}
               onChange=${(e) => toggleDesktop(e.target.checked)} />
        <span>${desktopInstalled ? "ярлык установлен" : "ярлык не установлен"}</span>
      </label>
      <div class="muted">
        ${s.llm_ready
          ? "LLM готов · активный профиль: " + (s.llm_active_profile_name || "—")
          : "LLM не инициализирован (нет активного профиля или master switch выключен)"}
      </div>
      <form class="row" onSubmit=${saveTtl}>
        <label>sudo TTL, с</label>
        <input name="ttl" type="number" min="0" value=${s.sudo_ttl_sec} />
        <button class="btn btn-sm">Сохранить</button>
      </form>
    </div>
    <${ProfileSection} />

    <${LLMProfilesSection} />

    <${SudoUnlockSection} />

    ${updateStatus
      ? html`<div class="card stack" id="settings-updates-section">
          <h3>Обновления</h3>
          <p class="muted">
            Текущая версия: <span class="mono">${updateStatus.current_version || "неизвестна"}</span>${
              " · "
            }канал установки: <span class="mono">${updateStatus.install_kind}</span>
            ${updateStatus.install_hint
              ? html`<br />ручное обновление: <span class="mono">${updateStatus.install_hint}</span>`
              : null}
          </p>
          <label class="check check--onoff">
            <input type="checkbox" checked=${!!updateStatus.check_on_start}
                   disabled=${updateBusy}
                   onChange=${(e) => toggleAutoCheck(e.target.checked)} />
            <span>${updateStatus.check_on_start ? "проверять автоматически" : "не проверять автоматически"}</span>
          </label>
          <p class="muted small">
            При включении раз в сутки делается HTTPS-запрос к GitHub
            Releases API. Отключите, если не хотите, чтобы панель
            обращалась в сеть за проверкой обновлений.
          </p>
          <div class="row">
            ${updateStatus.available
              ? html`<span class="badge warn">доступна ${updateStatus.available.version}</span>`
              : html`<span class="badge ok">актуальная версия</span>`}
            <span class="muted small">
              ${updateStatus.last_check_at
                ? "последняя проверка: " + updateStatus.last_check_at
                : "проверка ещё не выполнялась"}
            </span>
          </div>
          <div class="row">
            ${updateStatus.available && updateStatus.can_auto_update
              ? html`<button class="btn btn-sm btn-primary"
                              disabled=${updateBusy}
                              onClick=${() => setUpdateConfirmOpen(true)}>
                  ${updateBusy ? "Обновляю…" : "Обновить и остановить"}
                </button>`
              : null}
            ${updateStatus.available && !updateStatus.can_auto_update
              ? html`<a class="btn btn-sm btn-primary"
                        href=${updateStatus.available.url}
                        target="_blank" rel="noopener noreferrer">
                  Открыть релиз ${updateStatus.available.version}
                </a>`
              : null}
            <button class="btn btn-sm btn-ghost"
                    disabled=${updateBusy || updateStatus.checking}
                    onClick=${checkUpdatesNow}>
              ${(updateBusy || updateStatus.checking) ? "Проверяю…" : "Проверить сейчас"}
            </button>
          </div>
          ${updateStatus.apply_state === "git_pull"
            ? html`<div class="banner info">git pull…</div>`
            : null}
          ${updateStatus.apply_state === "pip_install"
            ? html`<div class="banner info">pip install -e . --upgrade…</div>`
            : null}
          ${updateStatus.apply_state === "failed"
            ? html`<div class="banner danger">Обновление не удалось. Панель продолжает работать на прежней версии.</div>`
            : null}
          ${updateErr ? html`<div class="err">${updateErr}</div>` : null}
          ${updateStatus.error
            ? html`<div class="muted small">Ошибка проверки: ${updateStatus.error}</div>`
            : null}
        </div>`
      : null}

    <div class="card stack">
      <h3>Сеть</h3>
      <p class="muted">
        Проверка сети: панель делает TCP-handshake к указанному ниже
        хосту. Если он не отвечает — приостанавливаются операции на
        <b> внешних</b> серверах.
      </p>
      <p class="muted small">
        Применяется только если есть хотя бы один внешний сервер*
      </p>
      <div class="row" style="align-items: flex-end;">
        <div style="flex: 2; min-width: 160px;">
          <label>IP для проверки</label>
          <input class="mono" value=${netDraft.host}
                 placeholder="1.1.1.1"
                 onInput=${(e) => setNetDraft({ ...netDraft, host: e.target.value })} />
        </div>
        <div style="flex: 1; min-width: 90px;">
          <label>Порт</label>
          <input type="number" min="1" max="65535"
                 value=${netDraft.port}
                 onInput=${(e) => setNetDraft({ ...netDraft, port: e.target.value })} />
        </div>
        <button class="btn btn-sm btn-primary"
                disabled=${netBusy}
                onClick=${saveNet}>
          ${netBusy ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
      ${netErr ? html`<div class="err">${netErr}</div>` : null}
    </div>

    <${RetentionSection} />

    <div class="card">
      <h3>Аномалии (in-memory EWMA)</h3>
      ${anoms.length === 0
        ? html`<p class="muted">Нет опубликованных аномалий (warmup 30 residual или спокойный ряд).</p>`
        : html`<ul class="alert-list">${anoms.map((a) => html`<li>${a.metric} z=${fmtNum(a.z_score, 2)} server_id=${a.server_id}</li>`)}</ul>`}
    </div>
    <div class="card">
      <h3>llm_audit</h3>
      <p class="muted">Промпт и ответ не хранятся — только hash, категории, токены.</p>
      ${llmRows.length === 0
        ? html`<p class="muted">Пока нет запросов к LLM.</p>`
        : html`<div class="table-wrap"><table>
            <thead><tr><th>время</th><th>role</th><th>status</th><th>hash</th></tr></thead>
            <tbody>${llmRows.map((r) => html`<tr key=${r.id}>
              <td class="mono">${r.timestamp_utc}</td>
              <td>${r.role}</td>
              <td>${r.status}</td>
              <td class="mono">${(r.prompt_hash || "").slice(0, 12)}…</td>
            </tr>`)}</tbody>
          </table></div>`}
    </div>
    ${updateConfirmOpen
      ? html`<${Modal} title="Обновить Melecho?" onClose=${() => setUpdateConfirmOpen(false)}
          footer=${html`<div class="row">
            <button class="btn btn-ghost btn-sm" onClick=${() => setUpdateConfirmOpen(false)}>Отмена</button>
            <div class="grow"></div>
            <button class="btn btn-primary btn-sm" onClick=${doApplyUpdate}>
              Обновить и остановить
            </button>
          </div>`}>
          <p>Будут выполнены:</p>
          <pre class="pre">git pull
pip install -e . --upgrade</pre>
          <p class="muted">
            После установки backend завершит работу. Запустите
            <span class="mono"> melecho</span> снова, чтобы открыть новую версию.
          </p>
          <p class="muted small">
            Если в репозитории есть незакоммиченные изменения — git pull
            может завершиться конфликтом. Панель продолжит работать на
            прежней версии, ошибка покажется ниже.
          </p>
        </${Modal}>`
      : null}
  </div>`;
}

// Типы условий, редактируемые в форме AlertRuleEditor.
const EDITABLE_CONDITION_KINDS = [
  { value: "metric_threshold", hint: "CPU/RAM/Disk/Load выше порога" },
  { value: "operation_check",  hint: "периодически запускать операцию" },
  { value: "metric_zscore",    hint: "отклонение от EWMA-нормы" },
  { value: "metric_stale",     hint: "метрики не приходят N секунд" },
  { value: "manual_op_failed", hint: "операция из UI упала" },
  { value: "reaction_failed",  hint: "реакция не смогла восстановить" },
];

const DEFAULT_ALERT_RULE_INITIAL = {
  name: "",
  condition_kind: "metric_threshold",
  severity: "warning",
  cond: { metric: "cpu", value_gte: 90 },
  // Специфично для operation_check (для остальных типов игнорируется).
  interval_sec: 300,
  servers: { all: true },
  auto_resolve_json_str: "",
  server_id: null,
  cooldown_sec: 300,
  enabled: true,
};

// Принимает либо строку из БД (/alert-rules), либо объект из LLM-ответа.
// condition_json и auto_resolve_json могут прийти как строкой (БД), так и
// объектом (LLM). cond — всегда объект (для формы), auto_resolve_json_str —
// текст (форма считает его свободным JSON).
function alertRuleToEditorInitial(r) {
  if (!r) return null;
  let cj = r.condition_json;
  if (typeof cj === "string") {
    try { cj = JSON.parse(cj); } catch { cj = {}; }
  }
  if (!cj || typeof cj !== "object") cj = {};

  const kind = r.condition_kind || "metric_threshold";

  // Форма держит cond в виде, удобном для полей. Для operation_check
  // это плоские UI-строки (params_str, expected_str), а не вложенные
  // объекты — иначе пришлось бы держать отдельные state'ы.
  let cond;
  if (kind === "operation_check") {
    cond = {
      operation_id: cj.operation_id || "",
      params_str: JSON.stringify(cj.params || {}, null, 2),
      expected_str: JSON.stringify(cj.expected || { exit: 0 }, null, 2),
    };
  } else {
    cond = { ...cj };
  }

  // servers_json хранится строкой в БД, но в форме — как объект.
  let servers = { all: true };
  if (r.servers_json) {
    try {
      const parsed = typeof r.servers_json === "string"
        ? JSON.parse(r.servers_json) : r.servers_json;
      if (parsed && typeof parsed === "object") servers = parsed;
    } catch {}
  }

  const ar = r.auto_resolve_json;
  return {
    id: r.id,
    name: r.name || "",
    condition_kind: kind,
    severity: r.severity || "warning",
    cond,
    interval_sec: r.interval_sec != null ? r.interval_sec : 300,
    servers,
    auto_resolve_json_str: ar
      ? (typeof ar === "string" ? ar : JSON.stringify(ar, null, 2))
      : "",
    server_id: r.server_id === undefined ? null : r.server_id,
    cooldown_sec: r.cooldown_sec || 300,
    enabled: r.enabled === undefined ? true : !!r.enabled,
  };
}

// Универсальная модалка «Возможный дубликат». Используется:
//   - из AlertRuleEditor — при попытке сохранить правило с дубликатом;
//   - из AlertRulesFromLLMModal — при клике на бейдж предупреждения.
// Родитель сам решает, что делает onConfirm (сохранить / создать это
// правило). Если onConfirm не передан — модалка только показывает инфу.
function RuleDupWarningModal({ dup, focus, onClose, onConfirm, confirmLabel }) {
  if (!dup) return null;
  // focus: "exact" | "conflict" | "override" | "error" | null (null = все блоки).
  // При клике на конкретный бейдж из карточки LLM-черновика родитель
  // передаёт focus, чтобы модалка показала только релевантный блок,
  // а не смесь. Из AlertRuleEditor при сохранении — focus=null.
  const showExact = dup.exact_duplicate
    && (!focus || focus === "exact" || focus === "all");
  const showConflicts = Array.isArray(dup.conflicts) && dup.conflicts.length
    && (!focus || focus === "conflict" || focus === "all");
  const showOverrides = Array.isArray(dup.overrides) && dup.overrides.length
    && (!focus || focus === "override" || focus === "all");
  const showErrors = Array.isArray(dup.errors) && dup.errors.length
    && (!focus || focus === "error" || focus === "all");
  // Жёсткие ошибки конфигурации — их нельзя обойти через «Я знаю, что делаю».
  const hasHardErrors = Array.isArray(dup.errors) && dup.errors.length > 0;
  // Блокеры, подтверждаемые через force — только если нет hard errors.
  const hasBlockers = !hasHardErrors && !!(
    dup.exact_duplicate || (dup.conflicts && dup.conflicts.length)
  );
  // Заголовок модалки меняем по focus.
  const headTitle = focus === "error"
    ? "Ошибка конфигурации"
    : focus === "override"
    ? "Перекрытие глобального правила"
    : (focus === "conflict" ? "Конфликт с правилом" : "Возможный дубликат");
  return html`<${Modal} title=${headTitle} onClose=${onClose}
      footer=${html`<div class="row">
        <button class="btn btn-ghost btn-sm" onClick=${onClose}>Отмена</button>
        <div class="grow"></div>
        ${onConfirm && hasBlockers
          ? html`<button class="btn btn-primary btn-sm" onClick=${onConfirm}>
              ${confirmLabel || "Я знаю, что делаю → Сохранить"}
            </button>`
          : null}
      </div>`}>
    ${showExact
      ? html`<div class="stack">
          <div class="banner warn">
            <b>Точный дубликат.</b> Правило с таким же типом условия,
          таким же condition_json и такой же областью действия уже есть.
          </div>
          <div class="form-sub">
            <label>Существующее правило</label>
            <div>${dup.exact_duplicate.name} <span class="muted small mono">#${dup.exact_duplicate.id}</span></div>
          </div>
        </div>`
      : null}
    ${showConflicts
      ? html`<div class="stack">
          <div class="banner warn">
            <b>Конфликт на ту же цель.</b> Уже есть правила на эту
          метрику/операцию. Действия будут дублироваться при срабатывании.
          </div>
          <div class="form-sub">
            <label>Конфликтующие правила</label>
            <ul class="alert-list">
              ${dup.conflicts.map((c) => html`<li key=${c.id}>
                ${c.name} <span class="muted small mono">#${c.id}</span>
                <span class="muted small">· ${c.reason}</span>
              </li>`)}
            </ul>
          </div>
        </div>`
      : null}
    ${showErrors
      ? html`<div class="stack">
          <div class="banner danger">
            <b>Ошибка конфигурации.</b> Правило нельзя создать — исправьте
          его через «Правку» и попробуйте снова.
          </div>
          <div class="form-sub">
            <label>Что не так</label>
            <ul class="alert-list">
              ${dup.errors.map((e, i) => html`<li key=${i}>
                ${e.kind === "missing_server"
                  ? html`Указан сервер <b>#${e.server_id}</b>, но такого сервера нет в системе (удалён или выбран неверно).`
                  : html`Неизвестная ошибка: <span class="mono">${e.kind}</span>`}
              </li>`)}
            </ul>
          </div>
        </div>`
      : null}
    ${showOverrides
      ? html`<div class="stack">
          ${focus === "override"
            ? html`<div class="banner warn">
                Это правило <b>перекрывает</b> глобальное. Для этого сервера
              будет действовать только оно.
              </div>`
            : null}
          <div class="form-sub">
            <label>Перекрываемые правила</label>
            <ul class="alert-list">
              ${dup.overrides.map((o) => html`<li key=${o.id}>
                ${o.name} <span class="muted small mono">#${o.id}</span>
              </li>`)}
            </ul>
          </div>
        </div>`
      : null}
    ${hasBlockers
      ? html`<p class="muted small">
          Сохранение создаст ещё одно правило. Сохраните если это осознанное решение.
        </p>`
      : null}
  </${Modal}>`;
}


function AlertRuleEditor({ initial, title, onSubmit, onClose }) {
  const [editing, setEditing] = useState(initial || DEFAULT_ALERT_RULE_INITIAL);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [servers, setServers] = useState([]);
  const [ops, setOps] = useState([]);
  const [dupWarning, setDupWarning] = useState(null);

  const isEdit = !!editing.id;
  const kind = editing.condition_kind;
  const cond = editing.cond || {};
  const kindIsOp = kind === "operation_check";

  useEffect(() => {
    api("/api/v1/servers")
      .then((r) => setServers(r.items || []))
      .catch(() => {});
    api("/api/v1/operations")
      .then((r) => setOps((r.items || []).filter((o) => o.valid)))
      .catch(() => {});
  }, []);

  function setCond(patch) {
    setEditing({ ...editing, cond: { ...cond, ...patch } });
  }
  function updateServers(v) {
    setEditing({ ...editing, servers: v });
  }

  // При смене типа сбрасываем condition к дефолтному для этого типа —
  // иначе в новом condition_json окажутся ключи от старого. servers
  // инициализируем один раз (не сбрасываем, если уже что-то выбрано).
  function setKind(k) {
    const defaults = {
      metric_threshold:  { metric: "cpu", value_gte: 90 },
      operation_check:   { operation_id: "", params_str: "{}", expected_str: '{\n  "exit": 0\n}' },
      metric_zscore:     { z_min: 3.0 },
      metric_stale:      { no_data_sec: 300 },
      manual_op_failed:  { exit_ne: 0 },
      reaction_failed:   { status_in: ["failed", "timeout"] },
    };
    const next = { ...editing, condition_kind: k, cond: defaults[k] || {} };
    if (k === "operation_check" && !next.servers) next.servers = { all: true };
    setEditing(next);
  }

  // Собирает condition_json из cond с валидацией обязательных полей.
  function buildCondition() {
    if (kind === "metric_threshold") {
      if (!cond.metric) throw new Error("укажите метрику");
      const opKey = ["value_gte", "value_gt", "value_lte", "value_lt"]
        .find((k) => cond[k] != null);
      if (!opKey) throw new Error("выберите условие и значение");
      if (cond[opKey] === "" || cond[opKey] == null || Number.isNaN(Number(cond[opKey]))) {
        throw new Error("значение порога: число");
      }
      return { metric: cond.metric, [opKey]: Number(cond[opKey]) };
    }
    if (kind === "operation_check") {
      const opId = (cond.operation_id || "").trim();
      if (!opId) throw new Error("выберите операцию");
      let params, expected;
      try { params = JSON.parse(cond.params_str || "{}"); }
      catch { throw new Error("params: некорректный JSON"); }
      try { expected = JSON.parse(cond.expected_str || '{"exit": 0}'); }
      catch { throw new Error("expected: некорректный JSON"); }
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error("params: JSON-объект");
      }
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
        throw new Error("expected: JSON-объект");
      }
      return { operation_id: opId, params, expected };
    }
    if (kind === "metric_zscore") {
      const out = {};
      if (cond.z_min != null && cond.z_min !== "") out.z_min = Number(cond.z_min);
      if (cond.z_max != null && cond.z_max !== "") out.z_max = Number(cond.z_max);
      if (out.z_min == null && out.z_max == null) {
        throw new Error("укажите хотя бы один порог (z_min или z_max)");
      }
      return out;
    }
    if (kind === "metric_stale") {
      const sec = Number(cond.no_data_sec);
      if (!Number.isFinite(sec) || sec <= 0) throw new Error("no_data_sec: положительное число");
      return { no_data_sec: sec };
    }
    if (kind === "manual_op_failed") {
      const v = Number(cond.exit_ne ?? 0);
      if (!Number.isFinite(v)) throw new Error("exit_ne: число");
      return { exit_ne: v };
    }
    if (kind === "reaction_failed") {
      const arr = Array.isArray(cond.status_in) ? cond.status_in : [];
      if (arr.length === 0) throw new Error("выберите хотя бы один статус");
      return { status_in: arr };
    }
    throw new Error("неизвестный тип условия");
  }

  function buildBody() {
    let cj;
    try { cj = buildCondition(); }
    catch (e) { throw new Error("условие: " + e.message); }
    let ar = null;
    const arText = (editing.auto_resolve_json_str || "").trim();
    if (arText) {
      try { ar = JSON.parse(arText); }
      catch { throw new Error("auto_resolve_json: некорректный JSON"); }
    }
    const body = {
      name: editing.name,
      severity: editing.severity,
      condition_json: cj,
      auto_resolve_json: ar,
      server_id: editing.server_id,
      cooldown_sec: editing.cooldown_sec,
      enabled: editing.enabled,
    };
    if (!isEdit) body.condition_kind = editing.condition_kind;

    if (kind === "operation_check") {
      const iv = Number(editing.interval_sec) || 300;
      if (!Number.isFinite(iv) || iv < 60 || iv > 86400) {
        throw new Error("interval_sec: 60..86400");
      }
      body.interval_sec = iv;
      const s = editing.servers || { all: true };
      if (s.all) {
        body.servers_json = { all: true };
        // server_id не заполняем — глобальное правило.
        body.server_id = null;
      } else {
        const ids = Array.isArray(s.ids) ? s.ids : [];
        if (ids.length === 0) throw new Error("выберите хотя бы один сервер");
        body.servers_json = { ids };
        // Денормализация: для single-server пишем server_id тоже — так
        // правило находится быстрее при списке в UI и fingerprint
        // совпадает со старыми checks. Для multi — null.
        body.server_id = ids.length === 1 ? ids[0] : null;
      }
    }
    return body;
  }

  function notifyOverrides(res) {
    if (!res || !res.overrides || res.overrides.length === 0) return;
    const names = res.overrides.map((o) => o.name).join(", ");
    showToast("Правило перекрывает глобальное: " + names, "warn");
  }

  async function save() {
    setBusy(true); setErr("");
    try {
      const body = buildBody();
      if (!isEdit) {
        let res;
        try {
          res = await api("/api/v1/alert-rules/check-duplicate", {
            method: "POST", body: JSON.stringify(body),
          });
        } catch (e) { res = null; }
        if (res && (res.exact_duplicate || (res.conflicts && res.conflicts.length))) {
          setDupWarning({ body, ...res });
          return;
        }
        if (res) notifyOverrides(res);
      }
      await onSubmit(body);
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSave() {
    const w = dupWarning;
    setDupWarning(null);
    if (!w) return;
    setBusy(true); setErr("");
    try {
      notifyOverrides(w);
      await onSubmit(w.body);
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  const headTitle = title || (isEdit ? "Правка правила алерта" : "Новое правило алерта");

  // Текущий operation_id может отсутствовать в ops (операция удалена).
  // Показываем fallback-option, чтобы пользователь видел «битое» значение.
  const currentOpId = (cond.operation_id || "").trim();
  const opInList = ops.some((o) => o.id === currentOpId);
  const serversState = editing.servers || { all: true };
  const serversAll = !!serversState.all;
  const serversIds = serversAll ? [] : (serversState.ids || []);

  return html`<${Modal} title=${headTitle} onClose=${onClose}
    footer=${html`<div class="row">
      <button class="btn btn-ghost btn-sm" onClick=${onClose}>Отмена</button>
      <div class="grow"></div>
      <button class="btn btn-primary btn-sm"
              disabled=${busy || !editing.name.trim()}
              onClick=${save}>
        ${busy ? "Сохранение…" : "Сохранить"}
      </button>
    </div>`}>
    ${err ? html`<div class="err">${err}</div>` : null}

    <div class="form-label-row">
      <label>Название</label>
      <label class="check check--onoff"
             title=${editing.enabled ? "Выключить правило" : "Включить правило"}>
        <input type="checkbox" checked=${editing.enabled}
               onChange=${(e) => setEditing({ ...editing, enabled: e.target.checked })} />
        <span>${editing.enabled ? "включена" : "выключена"}</span>
      </label>
    </div>
    <input value=${editing.name}
           onInput=${(e) => setEditing({ ...editing, name: e.target.value })} />

    <div class="form-section">
      <div class="form-section-title">
        Что отслеживаем
        <${InfoHint} text="Тип условия определяет, при каком событии создаётся алерт. Менять его у существующего правила нельзя — создайте новое." />
      </div>
      <${Radio}
        value=${kind}
        onChange=${isEdit ? () => {} : setKind}
        options=${EDITABLE_CONDITION_KINDS.map((k) => ({
          value: k.value,
          label: conditionKindLabel(k.value),
          hint: "— " + k.hint,
        }))} />
      ${isEdit
        ? html`<span class="muted small">тип условия менять нельзя</span>`
        : null}
    </div>

    <div class="form-section">
      <div class="form-section-title">Параметры условия</div>

      ${kind === "metric_threshold" ? html`
        <div class="row">
          <div style="flex:1">
            <label>Метрика</label>
            <select value=${cond.metric || "cpu"}
                    onChange=${(e) => setCond({ metric: e.target.value })}>
              <option value="cpu">CPU</option>
              <option value="ram">RAM</option>
              <option value="disk">Диск</option>
              <option value="load_1m">Load 1m</option>
            </select>
          </div>
          <div style="flex:1">
            <label>Условие</label>
            <select value=${
              ["value_gte","value_gt","value_lte","value_lt"].find((k) => cond[k] != null) || "value_gte"
            }
                    onChange=${(e) => {
                      const prevOp = ["value_gte","value_gt","value_lte","value_lt"].find((k) => cond[k] != null);
                      const prevVal = prevOp ? cond[prevOp] : 90;
                      const next = { ...cond };
                      for (const k of ["value_gte","value_gt","value_lte","value_lt"]) delete next[k];
                      next[e.target.value] = prevVal;
                      setEditing({ ...editing, cond: next });
                    }}>
              <option value="value_gte"><span class="op-sym">≥</span></option>
              <option value="value_gt"><span class="op-sym">${">"}</span></option>
              <option value="value_lte"><span class="op-sym">≤</span></option>
              <option value="value_lt"><span class="op-sym">${"<"}</span></option>
            </select>
          </div>
          <div style="flex:1">
            <label>Значение</label>
            <input type="number" value=${
              (() => {
                const k = ["value_gte","value_gt","value_lte","value_lt"].find((k) => cond[k] != null);
                return k ? cond[k] : 90;
              })()
            }
                   onInput=${(e) => {
                     const k = ["value_gte","value_gt","value_lte","value_lt"].find((k) => cond[k] != null) || "value_gte";
                     setCond({ [k]: e.target.value });
                   }} />
          </div>
        </div>
        <span class="muted small">
          Для Load 1m значение трактуется per-cpu: реальный порог = nproc × значение.
        </span>
      ` : null}

      ${kindIsOp ? html`
        <div class="form-sub">
          <label>Операция</label>
          <select value=${currentOpId}
                  onChange=${(e) => setCond({ operation_id: e.target.value })}>
            <option value="">— выбрать операцию —</option>
            ${ops.map((o) => html`<option value=${o.id} key=${o.id}>${o.name} (${o.id})</option>`)}
            ${currentOpId && !opInList
              ? html`<option value=${currentOpId}>${currentOpId} (операция удалена)</option>`
              : null}
          </select>
        </div>
        <div class="form-sub">
          <label>Параметры операции (JSON)
            <${InfoHint} text="Значения аргументов операции. У системных операций параметров нет — оставьте {}." />
          </label>
          <textarea class="mono llm-rule-cond" rows="3"
                    value=${cond.params_str || "{}"}
                    onInput=${(e) => setCond({ params_str: e.target.value })}></textarea>
        </div>
        <div class="form-sub">
          <label>Ожидаемый результат (JSON)
            <${InfoHint} text='Условие успеха. {"exit": 0} — только код возврата. Можно добавить {"exit": 0, "stdout_regex": "active"} для проверки stdout.' />
          </label>
          <textarea class="mono llm-rule-cond" rows="3"
                    value=${cond.expected_str || '{\n  "exit": 0\n}'}
                    onInput=${(e) => setCond({ expected_str: e.target.value })}></textarea>
        </div>
        <div class="row">
          <div style="flex:0 0 160px">
            <label>Интервал, сек</label>
            <input type="number" min="60" max="86400"
                   value=${editing.interval_sec}
                   onInput=${(e) => setEditing({ ...editing, interval_sec: Number(e.target.value) })} />
          </div>
          <span class="muted small" style="align-self:flex-end; padding-bottom:10px">
            Как часто запускать операцию. 60..86400.
          </span>
        </div>
        <div class="form-sub">
          <label>Серверы</label>
          <${Radio}
            value=${serversAll ? "all" : "specific"}
            onChange=${(v) => updateServers(
              v === "all" ? { all: true } : { ids: serversIds }
            )}
            options=${[
              { value: "all", label: "Все серверы" },
              { value: "specific", label: "Только выбранные" },
            ]} />
          ${!serversAll
            ? (servers.length === 0
                ? html`<div class="muted small">Серверов пока нет.</div>`
                : html`<${ServerPicker}
                    servers=${servers}
                    selected=${serversIds}
                    onChange=${(ids) => updateServers({ ids })} />`)
            : null}
        </div>
      ` : null}

      ${kind === "metric_zscore" ? html`
        <div class="row">
          <div style="flex:1">
            <label>z_min (нижняя граница, опционально)</label>
            <input type="number" step="0.1" value=${cond.z_min ?? ""}
                   onInput=${(e) => setCond({ z_min: e.target.value })} />
          </div>
          <div style="flex:1">
            <label>z_max (верхняя граница, опционально)</label>
            <input type="number" step="0.1" value=${cond.z_max ?? ""}
                   onInput=${(e) => setCond({ z_max: e.target.value })} />
          </div>
        </div>
        <span class="muted small">
          Алерт создаётся, если |z| ≥ z_min. Если задан z_max — только пока z ≤ z_max
          (используется для разведения warning и critical).
        </span>
      ` : null}

      ${kind === "metric_stale" ? html`
        <label>Нет метрик N секунд</label>
        <input type="number" min="30" value=${cond.no_data_sec || 300}
               onInput=${(e) => setCond({ no_data_sec: e.target.value })} />
        <span class="muted small">300 = 5 мин, 1800 = 30 мин.</span>
      ` : null}

      ${kind === "manual_op_failed" ? html`
        <label>exit_code ≠</label>
        <input type="number" value=${cond.exit_ne ?? 0}
               onInput=${(e) => setCond({ exit_ne: e.target.value })} />
        <span class="muted small">Обычно 0: алерт, если операция завершилась ненулевым кодом.</span>
      ` : null}

      ${kind === "reaction_failed" ? html`
        <label>Статусы реакции</label>
        <${MultiSelect}
          options=${[
            { value: "failed", label: "failed" },
            { value: "timeout", label: "timeout" },
          ]}
          selected=${Array.isArray(cond.status_in) ? cond.status_in : []}
          onChange=${(s) => setCond({ status_in: s })}
          placeholder="выбрать статусы" />
      ` : null}
    </div>

    <div class="form-section">
      <div class="form-section-title">Реакция</div>

      <div class="row">
        <div style="flex:1">
          <label>Severity</label>
          <select value=${editing.severity}
                  onChange=${(e) => setEditing({ ...editing, severity: e.target.value })}>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </div>
        ${kindIsOp
          ? null
          : html`<div style="flex:1">
              <label>Сервер</label>
              <select value=${editing.server_id == null ? "" : String(editing.server_id)}
                      onChange=${(e) => setEditing({
                        ...editing,
                        server_id: e.target.value === "" ? null : Number(e.target.value),
                      })}>
                <option value="">глобальное (все серверы)</option>
                ${servers.map((s) => html`<option value=${s.id} key=${s.id}>
                  ${s.name} (${s.llm_alias})
                </option>`)}
              </select>
            </div>`}
        <div style="flex:0 0 140px">
          <label>Cooldown, сек</label>
          <input type="number" min="0" max="86400" value=${editing.cooldown_sec}
                 onInput=${(e) => setEditing({ ...editing, cooldown_sec: Number(e.target.value) })} />
        </div>
      </div>

      ${(kind === "metric_threshold" || kind === "metric_zscore" || kind === "metric_stale")
        ? html`<div class="form-sub">
            <label>
              Auto-resolve (JSON или пусто)
              <${InfoHint} text='Условие автоматического закрытия алерта. Для threshold: {"below": 90}. Пустое поле = правило не будет сбрасываться автоматически.' />
            </label>
            <textarea class="mono llm-rule-cond" rows="2"
                      placeholder='{"below": 90}'
                      value=${editing.auto_resolve_json_str}
                      onInput=${(e) => setEditing({ ...editing, auto_resolve_json_str: e.target.value })}></textarea>
          </div>`
        : null}

    </div>

    ${dupWarning
      ? html`<${RuleDupWarningModal}
            dup=${dupWarning}
            onClose=${() => setDupWarning(null)}
            onConfirm=${confirmSave} />`
      : null}
  </${Modal}>`;
}

function AlertRuleDetailModal({ rid, onClose, onEdit, onReloadList }) {
  const [rule, setRule] = useState(null);
  const [runs, setRuns] = useState([]);
  const [servers, setServers] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadAll() {
    setErr("");
    try {
      const [r, s] = await Promise.all([
        api("/api/v1/alert-rules/" + rid),
        api("/api/v1/servers"),
      ]);
      setRule(r);
      setServers(s.items || []);
      if (r.condition_kind === "operation_check") {
        const rr = await api("/api/v1/alert-rules/" + rid + "/runs?limit=50");
        setRuns(rr.items || []);
      } else {
        setRuns([]);
      }
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { loadAll(); }, [rid]);

  async function runNow() {
    setBusy(true); setErr("");
    try {
      const res = await api("/api/v1/alert-rules/" + rid + "/run-now", {
        method: "POST", body: "{}",
      });
      const overall = res.overall || "—";
      showToast("Итог: " + overall, overall === "ok" ? "ok" : "warn");
      await loadAll();
      onReloadList && onReloadList();
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally { setBusy(false); }
  }

  if (!rule) {
    return html`<${Modal} title="Правило" onClose=${onClose}>
      ${err ? html`<div class="err">${err}</div>` : html`<p class="muted">Загрузка…</p>`}
    </${Modal}>`;
  }

  const isOpCheck = rule.condition_kind === "operation_check";
  const condParts = formatRuleCondition(rule);

  let cj = {};
  try {
    cj = typeof rule.condition_json === "string"
      ? JSON.parse(rule.condition_json)
      : (rule.condition_json || {});
  } catch { cj = {}; }

  let autoRes = null;
  if (rule.auto_resolve_json) {
    try {
      autoRes = typeof rule.auto_resolve_json === "string"
        ? JSON.parse(rule.auto_resolve_json)
        : rule.auto_resolve_json;
    } catch {}
  }

  let serversState = null;
  if (isOpCheck && rule.servers_json) {
    try {
      serversState = typeof rule.servers_json === "string"
        ? JSON.parse(rule.servers_json)
        : rule.servers_json;
    } catch {}
  }

  // Область действия правила: глобальное или per-server. Для operation_check
  // server_id может быть NULL даже при servers_json={ids:[N]} — это
  // денормализация, в карточке показываем реальные серверы запуска ниже.
  let scopeLabel = "глобальное";
  if (rule.server_id != null) {
    const s = servers.find((x) => x.id === rule.server_id);
    scopeLabel = s ? (s.name + " (" + s.llm_alias + ")") : ("#" + rule.server_id);
  }

  return html`<${Modal} title=${rule.name} onClose=${onClose}
    footer=${html`<div class="row">
      ${!rule.enabled ? html`<span class="muted small">Отключено</span>` : null}
      <div class="grow"></div>
      ${isOpCheck
        ? html`<button class="btn btn-sm" disabled=${busy} onClick=${runNow}>
            ${busy ? "Запуск…" : "Запустить сейчас"}
          </button>`
        : null}
      <button class="btn btn-sm btn-ghost"
              onClick=${() => onEdit && onEdit(rule)}>Правка</button>
      <button class="btn btn-sm btn-ghost" onClick=${onClose}>Закрыть</button>
    </div>`}>
    ${err ? html`<div class="err">${err}</div>` : null}

    <div class="row">
      <span class=${"badge " + (rule.severity === "critical" ? "danger" : rule.severity === "warning" ? "warn" : "")}>${rule.severity}</span>
      <span class="badge">${conditionKindLabel(rule.condition_kind)}</span>
      ${rule.builtin ? html`<span class="badge">builtin</span>` : null}
      ${!rule.enabled ? html`<span class="badge off">off</span>` : null}
    </div>

    <dl class="alert-detail-meta">
      <dt>ID</dt><dd>#${rule.id}</dd>
      <dt>Область</dt><dd>${scopeLabel}</dd>
      <dt>Cooldown</dt><dd>${rule.cooldown_sec} сек</dd>
      <dt>Создано</dt><dd>${rule.created_at || "—"}</dd>
      ${isOpCheck
        ? html`
            <dt>Интервал</dt><dd>${rule.interval_sec || "—"} сек</dd>
            <dt>Серверы запуска</dt><dd>${serversState && serversState.all
              ? "все"
              : (serversState && Array.isArray(serversState.ids)
                  ? serversState.ids.map((sid) => {
                      const s = servers.find((x) => x.id === sid);
                      return s ? s.name : ("#" + sid);
                    }).join(", ")
                  : "—")}</dd>
            <dt>Последний прогон</dt><dd>${rule.last_run_at || "—"}${rule.last_result ? " · " + rule.last_result : ""}</dd>
          `
        : html`
            <dt>Сработало</dt><dd>${rule.last_fired_at ? fmtAgo(rule.last_fired_at) : "ещё не срабатывало"}</dd>
          `}
    </dl>

    <h3 class="h2" style="font-size:1rem;margin-top:8px">Условие</h3>
    <div class="alert-card-desc">
      ${condParts.length ? condParts.join(" · ") : "(пусто)"}
    </div>
    <details>
      <summary class="muted small">сырой condition_json</summary>
      <pre class="pre">${JSON.stringify(cj, null, 2)}</pre>
    </details>

    ${autoRes
      ? html`<details>
          <summary class="muted small">auto-resolve</summary>
          <pre class="pre">${JSON.stringify(autoRes, null, 2)}</pre>
        </details>`
      : null}

    ${isOpCheck
      ? html`<h3 class="h2" style="font-size:1rem;margin-top:8px">История прогонов</h3>
          ${runs.length === 0
            ? html`<p class="muted">Прогонов пока нет.</p>`
            : html`<div class="alert-history">
                ${runs.map((run) => html`<div class="alert-history-item" key=${run.id}>
                  <span class=${"alert-history-kind " + (run.status === "ok" ? "auto_resolved" : "dismissed")}>${run.status}</span>
                  <span>exit=${run.exit_code ?? "—"}${run.error_code ? " · " + run.error_code : ""}</span>
                  <span class="alert-history-time">
                    ${run.timestamp_utc}${run.duration_ms != null ? html` · ${run.duration_ms} мс` : null}
                  </span>
                </div>`)}
              </div>`}`
      : null}
  </${Modal}>`;
}


function AlertRulesView({ initialDetailRid, onDetailClosed }) {
  const [items, setItems] = useState([]);
  const [servers, setServers] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorInit, setEditorInit] = useState(null);
  // Фильтры списка правил.
  //   serverFilter — "all" | "global" | "server:<id>";
  //   kindFilter   — condition_kind или "";
  //   sevFilter    — severity или "";
  //   qFilter      — поиск по имени (подстрока, регистронезависимо).
  const [serverFilter, setServerFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("");
  const [sevFilter, setSevFilter] = useState("");
  const [qFilter, setQFilter] = useState("");
  // Идёт «Запустить сейчас» — id правила, чтобы задизейблить кнопку
  // именно в этой карточке (а не все).
  const [runBusy, setRunBusy] = useState(null);
  // Открытая детальная модалка правила (id) или null. Может прийти
  // извне через initialDetailRid (например, клик «Правило #N» в
  // AlertDetailModal переключает сюда вкладку и просит открыть
  // конкретное правило).
  const [detailRid, setDetailRid] = useState(initialDetailRid ?? null);
  useEffect(() => {
    if (initialDetailRid != null) setDetailRid(initialDetailRid);
  }, [initialDetailRid]);

  async function load() {
    setErr("");
    try {
      const [r, s] = await Promise.all([
        api("/api/v1/alert-rules"),
        api("/api/v1/servers"),
      ]);
      // Builtin — вверху (это ядро системы), потом пользовательские
      // по имени. Внутри каждой группы — по name.
      const sorted = (r.items || []).slice().sort((a, b) => {
        const ba = a.builtin ? 0 : 1;
        const bb = b.builtin ? 0 : 1;
        if (ba !== bb) return ba - bb;
        return (a.name || "").localeCompare(b.name || "");
      });
      setItems(sorted);
      setServers(s.items || []);
    } catch (ex) { setErr(ex.message); }
  }
  useEffect(() => { load(); }, []);

  function serverLabel(r) {
    // Глобальное — просто текст; per-server — бейдж с именем сервера,
    // чтобы визуально отличать его от обычного текста.
    if (r.server_id == null) {
      return html`<span>глобальное</span>`;
    }
    const s = servers.find((x) => x.id === r.server_id);
    const label = s ? s.name : ("#" + r.server_id);
    return html`<span class="badge">${label}</span>`;
  }

  // Вызывается из AlertRuleEditor. Создаёт или обновляет правило,
  // в зависимости от наличия id в initial.
  async function save(body) {
    setBusy(true); setErr("");
    try {
      if (editorInit && editorInit.initial && editorInit.initial.id) {
        await api("/api/v1/alert-rules/" + editorInit.initial.id, {
          method: "PATCH", body: JSON.stringify(body),
        });
        showToast("Правило сохранено", "ok");
      } else {
        const r = await api("/api/v1/alert-rules", {
          method: "POST", body: JSON.stringify(body),
        });
        showToast("Правило создано (id: " + r.id + ")", "ok");
      }
      setEditorInit(null);
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
      // оставляем редактор открытым — пользователь исправит
    } finally { setBusy(false); }
  }

  async function toggle(r) {
    try {
      await api("/api/v1/alert-rules/" + r.id, {
        method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }),
      });
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); }
  }

  // Ручной запуск operation_check-правила. Для остальных типов API
  // вернёт E_PARAM — но кнопка и не отрисуется.
  async function runNow(r) {
    setRunBusy(r.id);
    setErr("");
    try {
      const res = await api("/api/v1/alert-rules/" + r.id + "/run-now", {
        method: "POST", body: "{}",
      });
      const overall = res.overall || "—";
      showToast("Проверка запущена. Итог: " + overall,
                overall === "ok" ? "ok" : "warn");
      await load();
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setRunBusy(null);
    }
  }


  async function resetRule(r) {
    if (!confirm("Сбросить правило «" + r.name + "» к дефолту?")) return;
    try {
      await api("/api/v1/alert-rules/" + r.id + "/reset", { method: "POST", body: "{}" });
      showToast("Правило сброшено к дефолту", "ok");
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); showToast("Ошибка: " + ex.message, "error"); }
  }

  async function remove(r) {
    if (!confirm("Удалить правило «" + r.name + "»?")) return;
    try {
      await api("/api/v1/alert-rules/" + r.id, { method: "DELETE" });
      showToast("Правило удалено", "ok");
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); showToast("Ошибка: " + ex.message, "error"); }
  }

  async function disableAll() {
    if (!confirm("Отключить ВСЕ правила алертов?\n\nНовые алерты создаваться не будут. Существующие — не трогаются.")) return;
    try {
      const r = await api("/api/v1/alert-rules/disable-all", { method: "POST", body: "{}" });
      showToast("Отключено правил: " + r.disabled, "warn");
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); }
  }

  async function resetDefaults() {
    if (!confirm("Сбросить все builtin-правила к дефолтам?\n\nПользовательские правила не тронутся.")) return;
    try {
      const r = await api("/api/v1/alert-rules/reset-defaults", { method: "POST", body: "{}" });
      showToast("Сброшено правил: " + r.updated, "ok");
      await load();
      window.dispatchEvent(new Event("melecho:refresh-status"));
    } catch (ex) { setErr(ex.message); }
  }

  const enabledCount = items.filter((r) => r.enabled).length;

  // Применяем все фильтры последовательно.
  const visibleItems = useMemo(() => {
    let list = items;
    if (serverFilter === "global") {
      list = list.filter((r) => r.server_id == null);
    } else if (serverFilter.startsWith("server:")) {
      const sid = Number(serverFilter.slice("server:".length));
      list = list.filter((r) => r.server_id === sid);
    }
    if (kindFilter) {
      list = list.filter((r) => r.condition_kind === kindFilter);
    }
    if (sevFilter) {
      list = list.filter((r) => r.severity === sevFilter);
    }
    const q = qFilter.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => (r.name || "").toLowerCase().includes(q));
    }
    return list;
  }, [items, serverFilter, kindFilter, sevFilter, qFilter]);

  return html`<div class="stack">
    ${err ? html`<div class="err">${err}</div>` : null}

    <div class="row">
      <button class="btn" onClick=${() => setEditorInit({ initial: null })}>+ Новое правило</button>
      <input class="grow" placeholder="поиск по имени" value=${qFilter}
             onInput=${(e) => setQFilter(e.target.value)}
             style="min-width:160px; height:36px; font-size:0.875rem;" />
      <button class="btn btn-sm btn-ghost" disabled=${busy}
              title="Отключить все правила без удаления"
              onClick=${disableAll}>Отключить все</button>
      <button class="btn btn-sm btn-ghost" disabled=${busy}
              title="Сбросить builtin-правила к заводским настройкам"
              onClick=${resetDefaults}>Сбросить к дефолтам</button>
    </div>

    <div class="row" style="gap:12px; align-items:flex-end;">
      <div class="form-sub" style="min-width:140px;">
        <label>Тип условия</label>
        <select value=${kindFilter} onChange=${(e) => setKindFilter(e.target.value)}
                style="height:32px; font-size:0.8125rem;">
          <option value="">любой</option>
          ${Object.entries(CONDITION_KIND_LABELS).map(([k, label]) => html`
            <option value=${k} key=${k}>${label}</option>
          `)}
        </select>
      </div>
      <div class="form-sub" style="min-width:120px;">
        <label>Severity</label>
        <select value=${sevFilter} onChange=${(e) => setSevFilter(e.target.value)}
                style="height:32px; font-size:0.8125rem;">
          <option value="">любая</option>
          <option value="critical">critical</option>
          <option value="warning">warning</option>
          <option value="info">info</option>
        </select>
      </div>
      <div class="form-sub" style="min-width:180px;">
        <label>Область</label>
        <select value=${serverFilter} onChange=${(e) => setServerFilter(e.target.value)}
                style="height:32px; font-size:0.8125rem;">
          <option value="all">все правила</option>
          <option value="global">только глобальные</option>
          ${servers.map((s) => html`<option value=${"server:" + s.id} key=${s.id}>
            для ${s.name} (${s.llm_alias})
          </option>`)}
        </select>
      </div>
      <span class="muted small grow" style="align-self:center;">
        Включено: ${visibleItems.filter((r) => r.enabled).length} из ${visibleItems.length}
        ${visibleItems.length !== items.length ? html` (отфильтровано из ${items.length})` : null}
      </span>
    </div>

    ${visibleItems.length === 0
      ? html`<div class="card empty">
          ${items.length === 0
            ? html`<h3>Правил алертов нет</h3>
                   <p class="muted">
                     Правило описывает условие, при котором создаётся алерт.
                     Может быть создано вручную или через LLM-чат (режим alert).
                   </p>`
            : html`<h3>Ничего не найдено</h3>
                   <p class="muted">Текущие фильтры не пропускают ни одного правила. Измените «Тип условия», «Severity», «Область» или очистите поиск.</p>`}
        </div>`
      : html`<div class="stack">
          ${visibleItems.map((r) => {
            const isCheck = r.condition_kind === "operation_check";
            const condParts = formatRuleCondition(r);
            return html`<article class=${"check-card " + (!r.enabled ? "disabled" : "")} key=${r.id}>
            <div class="check-head">
              <span class=${"badge " + (r.severity === "critical" ? "danger" : r.severity === "warning" ? "warn" : "")}>
                ${r.severity}
              </span>
              ${r.builtin ? html`<span class="badge">builtin</span>` : null}
              <div class="check-title">${r.name}</div>
              <span class="muted small">${conditionKindLabel(r.condition_kind)}</span>
            </div>
            <div class="check-meta-with-toggle">
              <div class="check-meta-group">
                <div class="check-meta">
                  ${condParts.map((p, i) => html`<span key=${i}>${p}</span>`)}
                  ${serverLabel(r)}
                  <span>cooldown: ${r.cooldown_sec}s</span>
                </div>
                ${isCheck && (r.last_result || r.last_run_at)
                  ? html`<div class="check-meta">
                      ${r.last_result
                        ? html`<span>последний прогон: <b>${r.last_result}</b></span>`
                        : null}
                      ${r.last_run_at ? html`<span>${fmtAgo(r.last_run_at)}</span>` : null}
                    </div>`
                  : null}
              </div>
              <label class="check check--onoff"
                     title=${r.enabled ? "Отключить" : "Включить"}>
                <input type="checkbox" checked=${r.enabled}
                       onChange=${() => toggle(r)} />
              </label>
            </div>
            <div class="check-actions">
              <button class="btn btn-sm"
                      onClick=${() => setDetailRid(r.id)}>Подробнее</button>
              ${isCheck
                ? html`<button class="btn btn-sm btn-ghost" disabled=${runBusy === r.id}
                              onClick=${() => runNow(r)}>
                    ${runBusy === r.id ? "Запуск…" : "Запустить сейчас"}
                  </button>`
                : null}
              <button class="btn btn-sm btn-ghost"
                      onClick=${() => setEditorInit({ initial: alertRuleToEditorInitial(r) })}>Правка</button>
              ${r.builtin
                ? html`<button class="btn btn-sm btn-ghost" onClick=${() => resetRule(r)}>Сбросить</button>`
                : html`<button class="btn btn-sm btn-danger" onClick=${() => remove(r)}>Удалить</button>`}
            </div>
          </article>`;
          })}
        </div>`}

    ${editorInit
      ? html`<${AlertRuleEditor}
            initial=${editorInit.initial}
            onSubmit=${save}
            onClose=${() => setEditorInit(null)} />`
      : null}

    ${detailRid != null
      ? html`<${AlertRuleDetailModal}
            rid=${detailRid}
            onClose=${() => {
              setDetailRid(null);
              onDetailClosed && onDetailClosed();
            }}
            onEdit=${(rule) => {
              setDetailRid(null);
              setEditorInit({ initial: alertRuleToEditorInitial(rule) });
            }}
            onReloadList=${load} />`
      : null}
  </div>`;
}



function AlertRulesFromLLMModal({ rules: initialRules, onClose, onDone }) {
  // Каждое правило — нормализованный editor-initial + status + dupCheck.
  // dupCheck = { exact_duplicate?, conflicts?, overrides? } | { error } | null.
  const [rules, setRules] = useState(() =>
    initialRules.map((r) => ({
      ...alertRuleToEditorInitial(r),
      status: "pending",
      id: null,
      error: null,
      dupCheck: null,
    }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // { index, initial } — открыть AlertRuleEditor для правки rules[index].
  const [editIdx, setEditIdx] = useState(null);
  // { index, focus } — открыть RuleDupWarningModal для rules[index].dupCheck.
  // focus = "exact" | "conflict" | "override" — какой блок показать.
  const [dupModalFor, setDupModalFor] = useState(null);
  // Пользователь нажал «Создать все» при наличии блокеров → кнопка
  // превратилась в «Я знаю, что делаю». Второй клик создаёт всё с force.
  const [forceConfirm, setForceConfirm] = useState(false);
  // Список серверов — для отображения имени, а не «server #N».
  const [servers, setServers] = useState([]);

  useEffect(() => {
    api("/api/v1/servers")
      .then((r) => setServers(r.items || []))
      .catch(() => {});
  }, []);

  // Единая метка сервера: имя (llm_alias, #id) или «глобальное».
  // Показываем id явно — иначе `llm_alias` вроде `server-1` визуально
  // неотличим от нумерации и путается с id (см. случай «server-2»:
  // alias не существует, но LLM решила, что это id=2).
  function serverLabel(r) {
    if (r.server_id == null) return "глобальное";
    const s = servers.find((x) => x.id === r.server_id);
    return s
      ? (s.name + " (" + s.llm_alias + ", #" + s.id + ")")
      : ("#" + r.server_id + " (не найден)");
  }

  // Клиентские ошибки правила. «Жёсткие» — их нельзя обойти через
  // «Я знаю, что делаю». Основная: server_id, которого нет в БД
  // (LLM может «выдумать» id — в отличие от формы, где выбор из списка).
  function validateRuleClient(r) {
    const errors = [];
    if (r.server_id != null) {
      if (!servers.some((s) => s.id === r.server_id)) {
        errors.push({ kind: "missing_server", server_id: r.server_id });
      }
    }
    if (r.condition_kind === "operation_check") {
      const s = r.servers || {};
      if (!s.all) {
        const ids = Array.isArray(s.ids) ? s.ids : [];
        for (const sid of ids) {
          if (!servers.some((x) => x.id === sid)) {
            errors.push({ kind: "missing_server", server_id: sid });
          }
        }
      }
    }
    return errors;
  }

  // Пересчитываем ошибки по мере изменения rules или servers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clientErrorsByIdx = useMemo(() => {
    const m = new Map();
    rules.forEach((r, i) => m.set(i, validateRuleClient(r)));
    return m;
  }, [rules, servers]);

  function clientErrors(i) {
    return clientErrorsByIdx.get(i) || [];
  }
  function hasHardError(i) {
    return clientErrors(i).length > 0;
  }

  function update(i, patch) {
    setRules((prev) => {
      const c = prev.slice();
      c[i] = { ...c[i], ...patch };
      return c;
    });
  }

  // «Блокирующий» дубликат — точный дубликат или конфликт по метрике/
  // операции. override (per-server поверх глобального) не блокирует —
  // это нормальный кейс, показываем бейджем. Принимает индекс: правила
  // могут иметь hard errors (см. clientErrors), которые тоже блокируют.
  function hasBlocker(i) {
    if (hasHardError(i)) return true;
    const r = rules[i];
    const d = r.dupCheck;
    if (!d || d.error) return false;
    if (d.exact_duplicate) return true;
    if (Array.isArray(d.conflicts) && d.conflicts.length > 0) return true;
    return false;
  }

  // Версии recheck по индексу. Защита от гонок: если пользователь
  // правит одну карточку дважды подряд, в dupCheck попадёт только
  // последний ответ. При removeRule версии сбрасываются целиком —
  // «зависшие» ответы не долетят до сдвинутых индексов.
  const recheckVersionRef = useRef({});

  // Перепроверка одной карточки. ruleOverride — объект правила, если
  // state ещё не обновился (вызов из saveEdited сразу после update).
  // buildBody/update — function declarations, hoisted, порядок не важен.
  async function recheckOne(idx, ruleOverride) {
    const rule = ruleOverride || rules[idx];
    if (!rule) return;
    const v = (recheckVersionRef.current[idx] || 0) + 1;
    recheckVersionRef.current[idx] = v;
    let body;
    try { body = buildBody(rule); }
    catch (ex) {
      if (recheckVersionRef.current[idx] === v) {
        update(idx, { dupCheck: { error: ex.message } });
      }
      return;
    }
    try {
      const res = await api("/api/v1/alert-rules/check-duplicate", {
        method: "POST", body: JSON.stringify(body),
      });
      if (recheckVersionRef.current[idx] === v) {
        update(idx, { dupCheck: res });
      }
    } catch (ex) {
      if (recheckVersionRef.current[idx] === v) {
        update(idx, { dupCheck: { error: ex.message || String(ex) } });
      }
    }
  }

  // При монтировании — прогон по всем черновикам. Не блокирует UI,
  // не мешает сохранению. Пользователь видит бейджи по мере ответов.
  useEffect(() => {
    const n = rules.length;
    for (let i = 0; i < n; i++) recheckOne(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function removeRule(i) {
    // Сбрасываем все версии — после удаления индексы сдвигаются,
    // «зависшие» recheck-ответы не должны попасть на другие карточки.
    recheckVersionRef.current = {};
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Открыть AlertRuleEditor в режиме создания. Карточка в rules
  // появится только после успешного сохранения формы — нажатие
  // «Отмена» ничего не добавляет.
  function openNewRuleEditor() {
    setEditIdx(-1);
  }

  // Сохранить новую карточку из редактора. Аналогично saveEdited, но
  // добавляет в конец списка вместо обновления.
  function saveNew(body) {
    const k = body.condition_kind;
    let cond;
    if (k === "operation_check") {
      const cj = body.condition_json || {};
      cond = {
        operation_id: cj.operation_id || "",
        params_str: JSON.stringify(cj.params || {}, null, 2),
        expected_str: JSON.stringify(cj.expected || { exit: 0 }, null, 2),
      };
    } else {
      cond = { ...(body.condition_json || {}) };
    }
    const newRule = {
      ...DEFAULT_ALERT_RULE_INITIAL,
      name: body.name,
      condition_kind: k,
      severity: body.severity,
      cond,
      interval_sec: body.interval_sec != null ? body.interval_sec : 300,
      servers: body.servers_json || { all: true },
      auto_resolve_json_str: body.auto_resolve_json
        ? JSON.stringify(body.auto_resolve_json, null, 2) : "",
      server_id: body.server_id,
      cooldown_sec: body.cooldown_sec,
      enabled: body.enabled,
      status: "pending",
      id: null,
      error: null,
      dupCheck: null,
    };
    const newIdx = rules.length;
    setRules((prev) => [...prev, newRule]);
    setEditIdx(null);
    recheckOne(newIdx, newRule);
  }

  // AlertRuleEditor отдаёт готовый body — сохраняем его в rules[i].
  // В БД ничего не пишем — это черновик, создание отдельной кнопкой.
  function saveEdited(body) {
    const i = editIdx;
    const k = body.condition_kind || rules[i].condition_kind;
    // cond — внутренний формат editor-initial. Для operation_check
    // плоские строки (params_str/expected_str), для метрик — прямой объект.
    let cond;
    if (k === "operation_check") {
      const cj = body.condition_json || {};
      cond = {
        operation_id: cj.operation_id || "",
        params_str: JSON.stringify(cj.params || {}, null, 2),
        expected_str: JSON.stringify(cj.expected || { exit: 0 }, null, 2),
      };
    } else {
      cond = { ...(body.condition_json || {}) };
    }
    const newRule = {
      ...rules[i],
      name: body.name,
      condition_kind: k,
      severity: body.severity,
      cond,
      interval_sec: body.interval_sec != null ? body.interval_sec : rules[i].interval_sec,
      servers: body.servers_json || rules[i].servers,
      auto_resolve_json_str: body.auto_resolve_json
        ? JSON.stringify(body.auto_resolve_json, null, 2) : "",
      server_id: body.server_id,
      cooldown_sec: body.cooldown_sec,
      enabled: body.enabled,
      status: "pending",
      error: null,
      // dupCheck оставляем как есть: пока идёт новая проверка, показываем
      // старый бейдж (не мигаем). recheckOne обновит его через ~секунду.
    };
    update(i, newRule);
    setEditIdx(null);
    // Перепроверяем дубли/конфликты для изменённого правила. Передаём
    // newRule явно — state ещё не пересчитан (setRules асинхронный).
    recheckOne(i, newRule);
  }

  // Собирает body из editor-initial. Бросает Error с человекочитаемым
  // сообщением, если поля не заполнены.
  function buildBody(r) {
    const k = r.condition_kind;
    let cj;
    if (k === "operation_check") {
      const opId = (r.cond && r.cond.operation_id || "").trim();
      if (!opId) throw new Error("не выбрана операция");
      let params, expected;
      try { params = JSON.parse(r.cond.params_str || "{}"); }
      catch { throw new Error("params: некорректный JSON"); }
      try { expected = JSON.parse(r.cond.expected_str || '{"exit": 0}'); }
      catch { throw new Error("expected: некорректный JSON"); }
      cj = { operation_id: opId, params, expected };
    } else {
      cj = { ...(r.cond || {}) };
    }
    let ar = null;
    const arText = (r.auto_resolve_json_str || "").trim();
    if (arText) {
      try { ar = JSON.parse(arText); }
      catch { throw new Error("auto_resolve_json: некорректный JSON"); }
    }
    const body = {
      name: r.name,
      condition_kind: k,
      severity: r.severity,
      condition_json: cj,
      auto_resolve_json: ar,
      server_id: r.server_id,
      cooldown_sec: r.cooldown_sec,
      enabled: r.enabled,
    };
    if (k === "operation_check") {
      const iv = Number(r.interval_sec) || 300;
      if (!Number.isFinite(iv) || iv < 60 || iv > 86400) {
        throw new Error("interval_sec: 60..86400");
      }
      body.interval_sec = iv;
      const s = r.servers || { all: true };
      if (s.all) {
        body.servers_json = { all: true };
        body.server_id = null;
      } else {
        const ids = Array.isArray(s.ids) ? s.ids : [];
        if (ids.length === 0) throw new Error("выберите хотя бы один сервер");
        body.servers_json = { ids };
        body.server_id = ids.length === 1 ? ids[0] : null;
      }
    }
    return body;
  }

  async function createOne(i, force = false) {
    const r = rules[i];
    if (r.status === "created") return true;
    // Hard errors (server_id не существует и т.п.) — не создаём
    // НИКОГДА, force их не обходит.
    if (hasHardError(i)) {
      update(i, {
        status: "failed",
        error: clientErrors(i).map((e) =>
          e.kind === "missing_server"
            ? `Сервер #${e.server_id} не существует`
            : `Ошибка конфигурации: ${e.kind}`
        ).join("; "),
      });
      return false;
    }
    // Блокирующий дубликат без явного force — не создаём.
    if (!force && hasBlocker(i)) return false;
    let body;
    try { body = buildBody(r); }
    catch (ex) {
      update(i, { status: "failed", error: ex.message });
      return false;
    }
    try {
      const resp = await api("/api/v1/alert-rules", {
        method: "POST",
        body: JSON.stringify(body),
      });
      update(i, { status: "created", id: resp.id, error: null });
      return true;
    } catch (ex) {
      update(i, { status: "failed", error: ex.message || String(ex) });
      return false;
    }
  }

  // Обёртка для кнопки «Создать всё равно» на карточке: явный force,
  // после успеха — тост, чтобы пользователь видел результат.
  async function createOneForce(i) {
    setBusy(true);
    try {
      const ok = await createOne(i, true);
      if (ok) showToast("Правило создано", "ok");
      else showToast("Не удалось создать", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createAll(force = false) {
    setBusy(true);
    setErr("");
    let ok = 0, fail = 0, skipped = 0, hardFail = 0;
    for (let i = 0; i < rules.length; i++) {
      if (rules[i].status === "created") { ok++; continue; }
      // Hard errors — не создаём ни при каком force.
      if (hasHardError(i)) { hardFail++; continue; }
      // Дубликат без явного force — пропускаем.
      if (!force && hasBlocker(i)) { skipped++; continue; }
      if (rules[i].status === "failed") update(i, { status: "pending", error: null });
      const res = await createOne(i, force);
      res ? ok++ : fail++;
    }
    setBusy(false);
    const parts = [];
    if (ok) parts.push(`создано ${ok}`);
    if (fail) parts.push(`ошибок ${fail}`);
    if (skipped) parts.push(`пропущено ${skipped}`);
    if (hardFail) parts.push(`с ошибками конфигурации ${hardFail}`);
    const msg = parts.join(", ") || "нечего создавать";
    if (fail > 0 || hardFail > 0) {
      setErr(msg + (hardFail ? ". Исправьте проблемные карточки через «Правку»." : ""));
      showToast(msg, "warn");
    } else if (skipped > 0) {
      setErr(msg + ".");
      showToast(msg, "warn");
    } else {
      showToast(msg, "ok");
      onDone && onDone(ok);
    }
  }

  // Есть ли хоть один блокирующий дубликат среди карточек.
  const blockersPresent = rules.some((_, i) =>
    rules[i].status !== "created" && hasBlocker(i),
  );

  const allCreated = rules.length > 0 && rules.every((r) => r.status === "created");
  const anyFailed = rules.some((r) => r.status === "failed");

  // Для превью условия в карточке — короткое человекочитаемое описание.
  // Используем formatRuleCondition от rules[i] (он сам парсит cond в
  // JSON-объект, но принимает «правило из БД» — приведём к нужной форме).
  function condPreview(r) {
    try {
      const fake = {
        condition_kind: r.condition_kind,
        condition_json: (() => {
          if (r.condition_kind === "operation_check") {
            const c = r.cond || {};
            return JSON.stringify({
              operation_id: c.operation_id || "",
              params: JSON.parse(c.params_str || "{}"),
              expected: JSON.parse(c.expected_str || "{}"),
            });
          }
          return JSON.stringify(r.cond || {});
        })(),
        interval_sec: r.interval_sec,
      };
      const parts = formatRuleCondition(fake);
      return parts.length ? parts.join(" · ") : "(условие не заполнено)";
    } catch {
      return "(условие не заполнено)";
    }
  }

  return html`<${Modal} title=${`Создание правил алертов (${rules.length})`}
      onClose=${onClose}
      footer=${html`<div class="row">
        <button class="btn btn-sm btn-ghost" onClick=${openNewRuleEditor}>+ Добавить правило</button>
        <div class="grow"></div>
        <button class="btn btn-sm btn-ghost" onClick=${onClose}>Закрыть</button>
        <button class="btn btn-sm btn-primary"
                disabled=${busy || allCreated || rules.length === 0}
                onClick=${() => {
                  if (allCreated || busy) return;
                  if (blockersPresent && !forceConfirm) {
                    setForceConfirm(true);
                    const n = rules.filter((r, idx) =>
                      r.status !== "created" && hasBlocker(idx)).length;
                    const m = `Найдено ${n} правил(о) с дубликатами/конфликтами. `
                      + `Нажмите «Я знаю, что делаю» ещё раз, чтобы создать их всё равно.`;
                    setErr(m);
                    showToast("Есть конфликты — подтвердите", "warn");
                    return;
                  }
                  createAll(forceConfirm);
                }}>
          ${busy ? "Создание…"
                 : allCreated ? "Все созданы"
                 : (blockersPresent && forceConfirm) ? "Я знаю, что делаю"
                 : anyFailed ? "Повторить неудачные"
                 : "Создать все"}
        </button>
      </div>`}>
    <p class="muted small">
      Каждое правило можно отредактировать («Правка») или удалить.
      После нажатия «Создать все» правила начнут работать сразу.
    </p>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${allCreated
      ? html`<div class="banner ok">Все правила созданы (id: ${rules.map((r) => r.id).join(", ")})</div>`
      : null}

    ${rules.length === 0
      ? html`<div class="muted small">Все правила удалены. Добавьте новое или закройте.</div>`
      : html`<div class="stack">
          ${rules.map((r, i) => {
            // Бейджи-предупреждения — над именем. Кликабельны, открывают
            // RuleDupWarningModal с деталями.
            const warnings = [];
            // Hard errors — красные, первыми.
            const cErrs = clientErrors(i);
            if (cErrs.length > 0) {
              const missingIds = cErrs
                .filter((e) => e.kind === "missing_server")
                .map((e) => "#" + e.server_id);
              const otherCount = cErrs.length - missingIds.length;
              const labelParts = [];
              if (missingIds.length) {
                labelParts.push("нет сервера " + missingIds.join(", "));
              }
              if (otherCount) labelParts.push("ошибок " + otherCount);
              warnings.push(html`<button type="button" key="err"
                  class="badge danger badge--clickable"
                  title="Ошибка конфигурации — нажмите для деталей"
                  onClick=${() => setDupModalFor({ index: i, focus: "error" })}>
                ${labelParts.join(" · ")}
              </button>`);
            }
            if (r.dupCheck && r.dupCheck.exact_duplicate) {
              warnings.push(html`<button type="button" key="ex"
                  class="badge warn badge--clickable"
                  title="Такое же правило уже есть — нажмите для деталей"
                  onClick=${() => setDupModalFor({ index: i, focus: "exact" })}>
                дубликат #${r.dupCheck.exact_duplicate.id}
              </button>`);
            }
            if (r.dupCheck && Array.isArray(r.dupCheck.conflicts) && r.dupCheck.conflicts.length) {
              warnings.push(html`<button type="button" key="cf"
                  class="badge warn badge--clickable"
                  title="Конфликтует по метрике/операции — нажмите для деталей"
                  onClick=${() => setDupModalFor({ index: i, focus: "conflict" })}>
                конфликт #${r.dupCheck.conflicts.map((c) => c.id).join(", #")}
              </button>`);
            }
            if (r.dupCheck && Array.isArray(r.dupCheck.overrides) && r.dupCheck.overrides.length) {
              warnings.push(html`<button type="button" key="ov"
                  class="badge badge--clickable"
                  title="Перекрывает глобальное правило — нажмите для деталей"
                  onClick=${() => setDupModalFor({ index: i, focus: "override" })}>
                перекрывает #${r.dupCheck.overrides.map((o) => o.id).join(", #")}
              </button>`);
            }
            // Статус — тоже в head-строке (над именем).
            const statusBadge = r.status === "created"
              ? html`<span class="badge ok" key="st">создано #${r.id}</span>`
              : r.status === "failed"
              ? html`<span class="badge fail" key="st">ошибка</span>`
              : null;
            const hasHead = !!(statusBadge || warnings.length || r.enabled === false);
            // Разбиваем condition на составляющие для мета-строки.
            const cond = condPreview(r);
            return html`<article class="check-card" key=${i}>
              ${hasHead
                ? html`<div class="check-head">
                    ${statusBadge}
                    ${warnings}
                    ${r.enabled === false ? html`<span class="badge off">выкл</span>` : null}
                  </div>`
                : null}
              <div class="check-title">${r.name}</div>
              <div class="check-meta-group">
                ${(() => {
                  // Разбиваем метаданные на строки по 3 элемента.
                  // Порядок: условие, cooldown, сервер | тип, severity.
                  const parts = [
                    html`<span key="c0">${cond}</span>`,
                    html`<span key="c1">cooldown: ${r.cooldown_sec}s</span>`,
                    html`<span key="c2">${serverLabel(r)}</span>`,
                    html`<span key="c3">${conditionKindLabel(r.condition_kind)}</span>`,
                    html`<span key="c4" class=${"sev-" + r.severity}>${r.severity}</span>`,
                  ];
                  const chunks = [];
                  for (let k = 0; k < parts.length; k += 3) {
                    chunks.push(parts.slice(k, k + 3));
                  }
                  return chunks.map((chunk, ci) => html`
                    <div class="check-meta" key=${"meta" + ci}>${chunk}</div>`);
                })()}
              </div>
              ${r.error ? html`<div class="err small">${r.error}</div>` : null}
              ${r.dupCheck && r.dupCheck.error
                ? html`<div class="muted small">проверка дублей: ${r.dupCheck.error}</div>`
                : null}
              <div class="check-actions">
                ${r.status !== "created"
                  ? html`<button class="btn btn-sm" onClick=${() => setEditIdx(i)}>Правка</button>
                         <button class="btn btn-sm btn-ghost" onClick=${() => removeRule(i)}>Удалить</button>`
                  : null}
              </div>
            </article>`;
          })}
        </div>`}

    ${editIdx != null
      ? html`<${AlertRuleEditor}
            initial=${editIdx === -1 ? DEFAULT_ALERT_RULE_INITIAL : rules[editIdx]}
            title=${editIdx === -1 ? "Новое правило" : "Редактирование (черновик)"}
            onSubmit=${editIdx === -1 ? saveNew : saveEdited}
            onClose=${() => setEditIdx(null)} />`
      : null}

    ${dupModalFor && rules[dupModalFor.index]
      ? (() => {
          const i = dupModalFor.index;
          const errs = clientErrors(i);
          const dc = rules[i].dupCheck || {};
          const dupData = { ...dc, errors: errs };
          const hasAnything = errs.length
            || dc.exact_duplicate
            || (Array.isArray(dc.conflicts) && dc.conflicts.length)
            || (Array.isArray(dc.overrides) && dc.overrides.length);
          if (!hasAnything) return null;
          return html`<${RuleDupWarningModal}
              dup=${dupData}
              focus=${dupModalFor.focus}
              onClose=${() => setDupModalFor(null)}
              onConfirm=${async () => {
                setDupModalFor(null);
                await createOneForce(i);
              }}
              confirmLabel="Я знаю, что делаю → Создать" />`;
        })()
      : null}
  </${Modal}>`;
}

function showToast(text, kind = "ok") {
  window.dispatchEvent(new CustomEvent("melecho:toast", {
    detail: { text, kind },
  }));
}


// Отправляет алерт в LLM-чат как вложение. Пользователь сам решит, что
// спросить — «объясни», «что делать», «создай реакцию». Это симметрично
// операции (↗ в UserOpEditor), единый UX экспорта в LLM.
//
// Никаких host/IP/username в текст не уходит — только llm_alias.
function exportAlertToLLM(a) {
  if (!a) return;
  const lines = [
    "Алерт #" + (a.id != null ? a.id : "?"),
    "Сервер: " + (a.llm_alias || ("#" + a.server_id)),
    "Severity: " + a.severity,
    "Источник: " + a.source,
    "Статус: " + (a.status || "open"),
  ];
  if (a.title) lines.push("Заголовок: " + a.title);
  if (a.description) lines.push("Описание: " + a.description);
  if (a.metric) lines.push("Метрика: " + a.metric);
  if (a.value != null) lines.push("Значение: " + a.value);
  if (a.threshold != null) lines.push("Порог: " + a.threshold);
  if (a.repeat_count && a.repeat_count > 1) {
    lines.push("Повторов: " + a.repeat_count);
  }
  if (a.first_seen_at) lines.push("Первое появление: " + a.first_seen_at);
  if (a.last_seen_at) lines.push("Последнее: " + a.last_seen_at);
  window.dispatchEvent(new CustomEvent("melecho:llm-attach", {
    detail: {
      name: "alert #" + (a.id != null ? a.id : "?"),
      content: lines.join("\n"),
      // Экспорт алерта — это контекст для объяснения, а не генерация
      // правила. Поэтому принудительно переводим чат в обычный режим,
      // чтобы вопрос пользователя не улетел в /suggest-alert-rule.
      force_mode: "chat",
      // alert_id позволяет показать под вложением кнопку «Открыть
      // алерт #N» — пользователь сразу может посмотреть детали.
      alert_id: a.id != null ? a.id : null,
    },
  }));
}


// Хук: постоянное SSE-соединение с бэкендом. На каждое событие вызывает
// onEventRef.current(ev). Колбэк передаём через ref, чтобы не пересоздавать
// соединение при ре-рендере AppShell.
//
// Используем fetch + ReadableStream, а не EventSource: EventSource не даёт
// передать X-Session-Token (S6-периметр), а токен в query утёк бы в логи.
//
// Переподключение: экспоненциальный backoff 1→2→4→8→...→30 сек. При 401
// (рестарт бэкенда, сессия потеряна) — не пытаемся переподключиться;
// основной polling-цикл сам поймает E_SESSION и перезагрузит страницу.
function useEventStream(onEventRef) {
  useEffect(() => {
    let stopped = false;
    let ctrl = null;
    let reconnectTimer = null;
    let reconnectMs = 1000;

    async function loop() {
      while (!stopped) {
        try {
          ctrl = new AbortController();
          const r = await fetch("/api/v1/events/stream", {
            headers: sessionToken ? { "X-Session-Token": sessionToken } : {},
            signal: ctrl.signal,
          });
          if (r.status === 401) {
            // Сессия инвалидирована — выходим. Polling-цикл сам среагирует.
            return;
          }
          if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
          reconnectMs = 1000;
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() || "";
            for (const part of parts) {
              for (const line of part.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload) continue;
                try {
                  const ev = JSON.parse(payload);
                  if (onEventRef.current) onEventRef.current(ev);
                } catch {}
              }
            }
          }
        } catch (ex) {
          if (stopped) return;
        }
        if (stopped) return;
        await new Promise((res) => { reconnectTimer = setTimeout(res, reconnectMs); });
        if (stopped) return;
        reconnectMs = Math.min(reconnectMs * 2, 30000);
      }
    }

    loop();
    return () => {
      stopped = true;
      if (ctrl) try { ctrl.abort(); } catch {}
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);
}


// Единый набор SVG-иконок для навигации. Все — 24×24, currentColor,
// stroke-width 1.8, скруглённые концы. Без emoji и символов.
const NAV_ICONS = {
  dash: 'M4 13h6V4H4v9zm10 7h6V11h-6v9zM4 20h6v-4H4v4zm10-13h6V4h-6v3z',
  alerts: 'M12 3a6 6 0 0 0-6 6v3.5L4 16v1h16v-1l-2-3.5V9a6 6 0 0 0-6-6zm0 18a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 21z',
  automation: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  audit: 'M5 3v18h14V7l-4-4H5zm9 1.5L18.5 8H14V4.5zM8 12h8v1.5H8V12zm0 4h8v1.5H8V16zm0-8h5v1.5H8V8z',
  settings: 'M3 6h10v2H3V6zm13 0h5v2h-5V6zM3 11h4v2H3v-2zm7 0h11v2H10v-2zM3 16h12v2H3v-2zm15 0h3v2h-3v-2zM11 5h2v4h-2V5zm-6 5h2v4H5v-4zm7 5h2v4h-2v-4z',
  logout: 'M10 17l1.4-1.4L8.8 13H16v-2H8.8l2.6-2.6L10 7l-5 5 5 5zm8-14H4v18h14v-3h-2v1H6V5h10v1h2V3z',
};

function NavIcon({ name }) {
  const d = NAV_ICONS[name];
  if (!d) return null;
  return html`<svg class="nav-icon" viewBox="0 0 24 24" width="18" height="18"
                   fill="currentColor" aria-hidden="true"><path d=${d}/></svg>`;
}


function AppShell() {
  const [view, setView] = useState("dash");
  const [sid, setSid] = useState(null);
  const [status, setStatus] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [integ, setInteg] = useState(null);
  const [alertCounts, setAlertCounts] = useState({ info: 0, warning: 0, critical: 0 });
  const [autoState, setAutoState] = useState(null);
  const [pendingReactions, setPendingReactions] = useState(0);
  const [pendingOpen, setPendingOpen] = useState(false);
  // Редактор операции, открытый из чата LLM («В редактор»).
  const [inlineEditor, setInlineEditor] = useState(null);
  // Кандидаты правил/реакций из LLM — показываются в модалке перед созданием.
  const [pendingAlertRules, setPendingAlertRules] = useState(null);
  const [pendingReaction, setPendingReaction] = useState(null);
  // Глобальный тост: единый механизм уведомлений в верхней части окна.
  // Компоненты (модалки, формы) диспатчат CustomEvent "melecho:toast"
  // с {text, kind}. AppShell показывает 3 сек и скрывает.
  const [toastMsg, setToastMsg] = useState(null);
  // Алерт, который нужно открыть в AlertsView (запрос из LLM через
  // кнопку «Открыть алерт #N»). Пока не null — AlertsView покажет модалку.
  const [pendingAlertId, setPendingAlertId] = useState(null);
  // Правило, которое нужно открыть в AlertRuleDetailModal (запрос из
  // AlertDetailModal — клик по «Правило #N»). Автоматически переключает
  // на вкладку Автоматизация → Правила.
  const [pendingRuleRid, setPendingRuleRid] = useState(null);
  // Правило + патч от LLM для применения правки. Открывается как
  // AlertRuleEditor поверх всего. Сохраняется через PATCH.
  const [pendingEditRule, setPendingEditRule] = useState(null);
  // Модалка «Завершить сессию?» с двумя опциями: только выйти (backend
  // остаётся жив) или остановить backend и выйти.
  const [logoutOpen, setLogoutOpen] = useState(false);
  // {version, tag, url} | null — доступно ли обновление. Источник:
  // status.update.available (обновляется раз в 25 сек) и SSE
  // update.available (мгновенно после каждой проверки).
  const [updateAvailable, setUpdateAvailable] = useState(null);
  // Состояние баннера интернета. Отдельно от status.internet_offline:
  //   idle     — обычный режим (offline показывается жёлтым warn)
  //   checking — идёт ручная проверка, кнопка со спиннером
  //   success  — проверка прошла, зелёный баннер 3 сек → idle
  //   fail     — проверка провалилась, красный баннер 3 сек → idle
  // Баннер живёт в DOM всегда; видимость — через класс .shown на
  // обёртке .banner-reveal (grid-template-rows: 0fr → 1fr). Это даёт
  // плавное появление/исчезновение без размонтирования.
  const [internetBannerState, setInternetBannerState] = useState("idle");
  // Отдельный флаг видимости. Нужен потому, что при success мы хотим
  // СНАЧАЛА плавно схлопнуть зелёный баннер (shown=false), и только
  // ПОТОМ сбросить state в idle. Если бы state сбрасывался сразу,
  // анимация схлопывания шла бы уже с warn-содержимым (жёлтым) —
  // это был баг, который заметил пользователь.
  const [internetBannerShown, setInternetBannerShown] = useState(false);
  // Countdown до следующей автоматической проверки (секунды).
  // null — polling выключен (интернет есть, или checking/success/fail).
  // Инициализируется из status / SSE net.status и декрементится
  // локально раз в секунду — между редкими SSE-событиями (backoff
  // 5→10→20→30) UI обновляется самостоятельно.
  const [internetNextCheckInSec, setInternetNextCheckInSec] = useState(null);
  // Refs на актуальные значения для чтения из SSE-колбэка (замыкания
  // фиксируются в момент вызова useEventStream и видят стейл-значения
  // из state). Присваиваем синхронно при каждом рендере.
  const statusRef = useRef(null);
  const internetBannerStateRef = useRef("idle");
  // true, пока идёт ручная проверка через doCheckInternet. В это окно
  // SSE-переходы checking:true↔false не перехватываются — иначе
  // возможна гонка: SSE увидит checking:false первым и поставит
  // success/fail раньше, чем придёт HTTP-ответ. Ручной сам поставит
  // результат по r.ok.
  const manualCheckInFlightRef = useRef(false);

  // applyBannerState: применяет новое состояние баннера к ref'у
  // СИНХРОННО + к React state асинхронно. Ref нужен, потому что
  // несколько net.status могут прийти в одном SSE-чанке (бывает на
  // localhost): обработчик второго события читает
  // internetBannerStateRef и должен видеть результат первого, а
  // setState в React батчится и между синхронными вызовами не
  // применяется.
  function applyBannerState(newState) {
    internetBannerStateRef.current = newState;
    setInternetBannerState(newState);
  }

  // Синхронизация shown со status.internet_offline. Не трогаем, пока
  // state в success/fail — там shown управляется таймерами вручную
  // (иначе на успех, когда status.internet_offline=false, shown
  // мгновенно станет false и схлопнется до обновления state).
  useEffect(() => {
    // Не трогаем видимость, пока играет success/fail (там свои таймеры)
    // или пока идёт проверка (иначе при переходе offline:true→false
    // баннер схлопнется с warn-содержимым до того, как triggerBannerSuccess
    // успеет переключить state в success).
    if (internetBannerState === "success"
        || internetBannerState === "fail"
        || internetBannerState === "checking") return;
    setInternetBannerShown(!!(status && status.internet_offline));
  }, [status && status.internet_offline, internetBannerState]);

  // Инициализация countdown'а из status при первом рендере и при
  // периодическом polling'е раз в 25 сек (refreshStatus). SSE net.status
  // обновляет быстрее, это fallback.
  useEffect(() => {
    const n = status && status.internet_next_check_in_sec;
    if (typeof n === "number" && n >= 0) {
      setInternetNextCheckInSec(n);
    } else if (status && !status.internet_offline) {
      setInternetNextCheckInSec(null);
    }
  }, [status && status.internet_next_check_in_sec, status && status.internet_offline]);

  // Локальный decrement countdown'а раз в секунду. Работает только
  // когда мы в idle-состоянии баннера (не checking/success/fail) и
  // число > 0. До нуля не опускаемся — там либо сработает polling,
  // либо SSE пришлёт новое число. Отрицательные значения не показываем.
  useEffect(() => {
    if (internetNextCheckInSec == null || internetNextCheckInSec <= 0) return undefined;
    if (internetBannerState !== "idle") return undefined;
    const t = setInterval(() => {
      setInternetNextCheckInSec((prev) => {
        if (prev == null || prev <= 1) return prev;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [internetNextCheckInSec, internetBannerState]);
  // Дебаунсер для счётчиков: SSE может выпустить 5 событий за 100 мс,
  // не хотим дёргать API 5 раз. Окно 250 мс собирает пачку в один refetch.
  const countsDebounceRef = useRef(null);
  const onEventRef = useRef(null);

  async function refreshStatus() {
    const s = await api("/api/v1/system/status");
    setStatus(s);
    setInteg(s.audit);
    // Badge обновления в шапке. status.update.available — {version,tag,url}|null.
    try {
      setUpdateAvailable(s.update && s.update.available ? s.update.available : null);
    } catch {}
    try {
      const c = await api("/api/v1/alerts/counts");
      setAlertCounts(c);
    } catch {}
    try {
      const a = await api("/api/v1/automation/state");
      setAutoState(a);
    } catch {}
    try {
      const p = await api("/api/v1/reactions/pending");
      setPendingReactions(p.count || 0);
    } catch {}
  }
  // Обновление счётчиков по SSE-событиям. Дебаунс 250 мс: пачка
  // событий приводит к одному refetch. Меньше запросов, чем polling
  // раз в 5 сек, и обновление почти мгновенное.
  function scheduleRefreshCounts() {
    clearTimeout(countsDebounceRef.current);
    countsDebounceRef.current = setTimeout(async () => {
      try {
        const [c, p] = await Promise.all([
          api("/api/v1/alerts/counts"),
          api("/api/v1/reactions/pending"),
        ]);
        setAlertCounts(c);
        setPendingReactions(p.count || 0);
      } catch {}
    }, 250);
  }

  // Обработчик SSE-событий. onEventRef.current переопределяется на
  // каждом рендере — так колбэк всегда свежий, а соединение одно.
  onEventRef.current = (ev) => {
    if (!ev || typeof ev.topic !== "string") return;
    // net.status: смена глобального состояния интернета или флага
    // активной проверки. Обновляем status локально — баннер в шапке
    // реагирует мгновенно, не ждём polling'а раз в 25 сек.
    if (ev.topic === "net.status") {
      const p = ev.payload || {};
      const nowOffline = !!p.internet_offline;
      const nowChecking = !!p.internet_checking;

      setStatus((prev) => prev ? {
        ...prev,
        internet_offline: nowOffline,
        internet_checking: nowChecking,
      } : prev);
      // Countdown: сервер присылает next_check_in_sec в каждом событии
      // (при смене offline/checking и при смене backoff). null → не offline.
      const n = p.next_check_in_sec;
      setInternetNextCheckInSec(
        typeof n === "number" && n >= 0 ? n : null,
      );

      // Автоматический polling тоже виден в UI (сервер ставит
      // checking=True на время handshake). Переходы checking:true↔false
      // обрабатываем ТОЛЬКО для авто-проверок — для ручных результат
      // ставит сам doCheckInternet по HTTP-ответу (он выставляет
      // manualCheckInFlightRef).
      //
      // ВАЖНО: проверяем через internetBannerStateRef (синхронный ref),
      // а не через React state и не через statusRef. Два net.status
      // могут прийти в одном SSE-чанке (бывает на localhost) — тогда
      // они обрабатываются в одном тике React, и setState не успевает
      // примениться между ними. Ref обновляется синхронно через
      // applyBannerState, поэтому второй вызов видит актуальное
      // состояние первого.
      if (!manualCheckInFlightRef.current) {
        const bannerState = internetBannerStateRef.current;
        if (nowChecking && bannerState === "idle") {
          // Начало авто-проверки.
          applyBannerState("checking");
        } else if (!nowChecking && bannerState === "checking") {
          // Конец авто-проверки: результат по offline-флагу.
          if (!nowOffline) {
            // Интернет вернулся — зелёный баннер 3 сек.
            triggerBannerSuccess();
          } else {
            // Всё ещё offline — возвращаемся в idle. Не мигаем красным
            // на каждой авто-проверке (иначе раз в 5-30 сек баннер
            // дёргается, что раздражает).
            applyBannerState("idle");
          }
        }
      }
      return;
    }
    if (ev.topic === "update.available" || ev.topic === "update.apply") {
      // Прокидываем событие в SettingsView (секция «Обновления») и
      // в шапку. SettingsView сам мержит с текущим состоянием.
      window.dispatchEvent(new CustomEvent("melecho:update-event", {
        detail: ev,
      }));
      if (ev.topic === "update.available") {
        const p = ev.payload || {};
        setUpdateAvailable(p.available || null);
      }
      return;
    }
    if (ev.topic === "alert.created" || ev.topic === "alert.updated") {
      scheduleRefreshCounts();
    } else if (ev.topic === "reaction.pending" || ev.topic === "reaction.finished") {
      scheduleRefreshCounts();
    }
    // Дополнительно ретранслируем reaction-события как CustomEvent,
    // чтобы ReactionsView могла перезагрузить «Последние запуски»
    // мгновенно, а не ждать polling 10 сек.
    if (typeof ev.topic === "string" && ev.topic.startsWith("reaction.")) {
      window.dispatchEvent(new CustomEvent("melecho:reaction-event", {
        detail: ev,
      }));
    }
    // rule.finished — прогон operation_check-правила. CustomEvent пока
    // никто не слушает (ChecksView удалён), но пусть ретрансляция будет:
    // когда появится «Последние прогоны» в RulesView — подпишется сюда.
    if (typeof ev.topic === "string" && ev.topic.startsWith("rule.")) {
      window.dispatchEvent(new CustomEvent("melecho:rule-event", {
        detail: ev,
      }));
    }
    if (typeof ev.topic === "string" && ev.topic.startsWith("metric.")) {
      window.dispatchEvent(new CustomEvent("melecho:metric-event", {
        detail: ev,
      }));
    }
    if (typeof ev.topic === "string" && ev.topic.startsWith("alert.")) {
      window.dispatchEvent(new CustomEvent("melecho:alert-event", {
        detail: ev,
      }));
    }
  };
  useEventStream(onEventRef);

  useEffect(() => {
    refreshStatus();
    // Счётчики (алерты + pending reactions) — раз в 5 секунд.
    // Полный рефреш — реже (25 с).
    const light = setInterval(async () => {
      try {
        const [c, p] = await Promise.all([
          api("/api/v1/alerts/counts"),
          api("/api/v1/reactions/pending"),
        ]);
        setAlertCounts(c);
        setPendingReactions(p.count || 0);
      } catch {}
    }, 5000);
    const heavy = setInterval(refreshStatus, 25000);
    const onRefresh = () => { refreshStatus(); };
    window.addEventListener("melecho:refresh-status", onRefresh);
    const onOpenEditor = (ev) => {
      const y = ev && ev.detail && ev.detail.yaml;
      if (typeof y === "string" && y.trim()) setInlineEditor({ yaml: y });
    };
    const onCreateAlertRules = (ev) => {
      const rules = ev && ev.detail && ev.detail.rules;
      if (Array.isArray(rules) && rules.length) setPendingAlertRules(rules);
    };
    const onCreateReaction = (ev) => {
      const rule = ev && ev.detail && ev.detail.rule;
      if (rule && typeof rule === "object") setPendingReaction(rule);
    };
    const onOpenAlert = (ev) => {
      const aid = ev && ev.detail && ev.detail.alert_id;
      if (typeof aid === "number" && aid > 0) {
        setView("alerts");
        setSid(null);
        setPendingAlertId(aid);
      }
    };
    const onToast = (ev) => {
      const d = (ev && ev.detail) || {};
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (!text) return;
      setToastMsg({ text, kind: d.kind || "ok" });
    };
    const onOpenRule = (ev) => {
      const rid = ev && ev.detail && ev.detail.rule_id;
      if (typeof rid === "number" && rid > 0) {
        setView("automation");
        setSid(null);
        setPendingRuleRid(rid);
      }
    };
    const onApplyRulePatch = (ev) => {
      const p = ev && ev.detail;
      if (!p || typeof p.rule_id !== "number" || !p.patch) return;
      // Открываем AlertRuleEditor с правилом, на которое накладываем patch.
      // Само правило подгружаем здесь, а не ждём AlertRuleEditor: нужно
      // слить patch с текущими полями ДО открытия формы.
      api("/api/v1/alert-rules/" + p.rule_id)
        .then((rule) => {
          const initial = alertRuleToEditorInitial(rule);
          // patch может содержать condition_json, auto_resolve_json,
          // interval_sec, servers_json — раскладываем в editor-initial.
          const patch = p.patch;
          if (patch.name != null) initial.name = patch.name;
          if (patch.severity != null) initial.severity = patch.severity;
          if (patch.enabled != null) initial.enabled = !!patch.enabled;
          if (patch.cooldown_sec != null) initial.cooldown_sec = patch.cooldown_sec;
          if (patch.server_id !== undefined) initial.server_id = patch.server_id;
          if (patch.auto_resolve_json !== undefined) {
            initial.auto_resolve_json_str = patch.auto_resolve_json
              ? JSON.stringify(patch.auto_resolve_json, null, 2) : "";
          }
          if (patch.condition_json) {
            const k = rule.condition_kind;
            if (k === "operation_check") {
              initial.cond = {
                operation_id: patch.condition_json.operation_id || initial.cond.operation_id,
                params_str: JSON.stringify(
                  patch.condition_json.params || JSON.parse(initial.cond.params_str || "{}"),
                  null, 2,
                ),
                expected_str: JSON.stringify(
                  patch.condition_json.expected || JSON.parse(initial.cond.expected_str || "{}"),
                  null, 2,
                ),
              };
            } else {
              initial.cond = { ...(initial.cond || {}), ...patch.condition_json };
            }
          }
          if (patch.interval_sec != null) initial.interval_sec = patch.interval_sec;
          if (patch.servers_json) initial.servers = patch.servers_json;
          // Открываем редактор как отдельную модалку поверх AppShell.
          // Используем inlineEditor? Нет — это UserOpEditor. Нужен
          // отдельный state. Проще всего открыть через detailRid не
          // подходит. Откроем через общий state pendingEditRule.
          setPendingEditRule({ initial });
        })
        .catch((ex) => {
          showToast("Не удалось открыть правило: " + ex.message, "error");
        });
    };
    window.addEventListener("melecho:llm-open-editor", onOpenEditor);
    window.addEventListener("melecho:llm-create-alert-rules", onCreateAlertRules);
    window.addEventListener("melecho:llm-create-reaction", onCreateReaction);
    window.addEventListener("melecho:toast", onToast);
    window.addEventListener("melecho:llm-open-alert", onOpenAlert);
    window.addEventListener("melecho:llm-open-rule", onOpenRule);
    window.addEventListener("melecho:llm-apply-rule-patch", onApplyRulePatch);
    return () => {
      clearInterval(light);
      clearInterval(heavy);
      if (countsDebounceRef.current) clearTimeout(countsDebounceRef.current);
      window.removeEventListener("melecho:refresh-status", onRefresh);
      window.removeEventListener("melecho:llm-open-editor", onOpenEditor);
      window.removeEventListener("melecho:llm-create-alert-rules", onCreateAlertRules);
      window.removeEventListener("melecho:llm-create-reaction", onCreateReaction);
      window.removeEventListener("melecho:toast", onToast);
      window.removeEventListener("melecho:llm-open-alert", onOpenAlert);
      window.removeEventListener("melecho:llm-open-rule", onOpenRule);
      window.removeEventListener("melecho:llm-apply-rule-patch", onApplyRulePatch);
    };
  }, []);


  // Ручная проверка интернета из баннера. Последовательность состояний:
  //   click → checking → (success | fail) — 3 сек — idle
  // При success ещё локально обновляем status.internet_offline=false,
  // чтобы SSE/polling не «откатили» зелёный баннер раньше времени.
  // При fail status не трогаем — баннер вернётся в обычный warn
  // через 3 секунды, как и просил UX.
  const internetStateTimerRef = useRef(null);
  // Синхронное обновление refs — присваиваем при каждом рендере,
  // чтобы SSE-колбэк видел свежие значения.
  statusRef.current = status;
  internetBannerStateRef.current = internetBannerState;

  // Общий путь для success-состояния: зелёный баннер 3 сек, затем
  // схлопывание с kind=ok (внутренний баннер остаётся зелёным до
  // конца transition), затем state=idle. Используется и ручной
  // проверкой, и авто-polling'ом при возврате интернета.
  function triggerBannerSuccess() {
    if (internetStateTimerRef.current) {
      clearTimeout(internetStateTimerRef.current);
      internetStateTimerRef.current = null;
    }
    applyBannerState("success");
    setInternetBannerShown(true);
    internetStateTimerRef.current = setTimeout(() => {
      setInternetBannerShown(false);
      internetStateTimerRef.current = setTimeout(() => {
        applyBannerState("idle");
        internetStateTimerRef.current = null;
      }, 400);
    }, 3000);
  }

  // Fail: красный баннер 3 сек, затем назад в warn (offline-флаг
  // остаётся true, баннер не схлопывается).
  function triggerBannerFail() {
    if (internetStateTimerRef.current) {
      clearTimeout(internetStateTimerRef.current);
      internetStateTimerRef.current = null;
    }
    applyBannerState("fail");
    setInternetBannerShown(true);
    internetStateTimerRef.current = setTimeout(() => {
      applyBannerState("idle");
      internetStateTimerRef.current = null;
    }, 3000);
  }

  async function doCheckInternet() {
    if (internetBannerState === "checking") return;
    if (internetStateTimerRef.current) {
      clearTimeout(internetStateTimerRef.current);
      internetStateTimerRef.current = null;
    }
    // Флаг для SSE-обработчика: переходы checking:true↔false от этого
    // запроса не перехватываем — результат ставим сами по r.ok.
    manualCheckInFlightRef.current = true;
    setInternetBannerState("checking");
    // Countdown не показываем (кнопка показывает спиннер).
    setInternetNextCheckInSec(0);
    let r = null;
    try {
      r = await api("/api/v1/system/check-internet", {
        method: "POST", body: "{}",
      });
    } catch (ex) {
      console.warn("check-internet failed:", ex && ex.message);
    } finally {
      manualCheckInFlightRef.current = false;
    }
    const ok = !!(r && r.ok);
    // Синхронизируем status и countdown из ответа — на случай, если
    // SSE не сработал (разрыв канала). Fallback.
    if (r) {
      setStatus((prev) => prev ? {
        ...prev,
        internet_offline: !!r.internet_offline,
        internet_checking: !!r.internet_checking,
        internet_last_check_at: r.internet_last_check_at,
      } : prev);
      if (typeof r.next_check_in_sec === "number") {
        setInternetNextCheckInSec(r.next_check_in_sec);
      } else if (!r.internet_offline) {
        setInternetNextCheckInSec(null);
      }
    }
    // Если SSE уже отработал (state сменился раньше) — не перезаписываем.
    if (internetBannerStateRef.current !== "checking") return;
    if (ok) triggerBannerSuccess();
    else triggerBannerFail();
  }
  // Чистим таймер при unmount, чтобы setTimeout не дёргал setState
  // после размонтирования.
  useEffect(() => () => {
    if (internetStateTimerRef.current) {
      clearTimeout(internetStateTimerRef.current);
    }
  }, []);

  // «Выйти из профиля»: освободить ресурсы профиля (SSH, БД, DEK),
  // получить свежий bootstrap и перезагрузить страницу на стартовый
  // экран. Backend продолжает работать, активный профиль не меняется.
  async function doLogoutProfile() {
    let r = null;
    try {
      r = await api("/api/v1/session/logout", {
        method: "POST",
        body: JSON.stringify({ unload_profile: true }),
      });
    } catch (e) { /* сеть может дёрнуться, не критично */ }
    sessionToken = "";
    try { sessionStorage.removeItem("melecho.session"); } catch {}
    const bs = r && r.bootstrap;
    if (bs) {
      // ?pr=... (profile reset) — как ?ps= в switchProfile: гарантирует
      // реальную перезагрузку вместо hashchange, если URL сейчас уже
      // вида /#bootstrap=...
      location.replace("/?pr=" + Date.now() + "#bootstrap=" + encodeURIComponent(bs));
    } else {
      // Fallback на случай, если сервер не отдал bootstrap (ошибка
      // сети). Вкладка перезагрузится, Root уйдёт в need-boot —
      // это лучше, чем остаться на старом экране со сброшенным
      // профилем.
      location.reload();
    }
  }

  // «Остановить и выйти»: backend делает graceful shutdown (закрывает
  // SSH, uvicorn should_exit=True). Мы НЕ перезагружаем вкладку —
  // вместо этого шлём событие Root'у, он покажет экран «Melecho
  // остановлен». Перезагрузка тут бессмысленна — сервер уже мёртв,
  // а экран stopped приятнее, чем need-boot.
  async function doStopAndLogout() {
    try {
      await api("/api/v1/session/logout", {
        method: "POST",
        body: JSON.stringify({ stop_backend: true }),
      });
    } catch (e) { /* backend завершается, сеть сейчас отвалится */ }
    sessionToken = "";
    sessionStorage.removeItem("melecho.session");
    setLogoutOpen(false);
    window.dispatchEvent(new CustomEvent("melecho:backend-stopped"));
  }

  return html`<div class="shell">
    <header class="top">
      <div class="brand">
        <${IconShield} />
        <div class="brand-text">
          <h1>Melecho</h1>
          <p>local-first · без агента на серверах</p>
          ${updateAvailable
            ? html`<button class="brand-badge"
                    title=${"Доступна версия " + updateAvailable.version}
                    onClick=${() => {
                      setView("set");
                      setSid(null);
                      setTimeout(() => {
                        window.dispatchEvent(new Event("melecho:scroll-to-updates"));
                      }, 50);
                    }}>
                доступно обновление
              </button>`
            : null}
        </div>
      </div>
      <nav class="nav">
        <button class=${view === "dash" ? "on" : ""}
                title="Дашборд"
                onClick=${() => { setView("dash"); setSid(null); }}>
          <${NavIcon} name="dash" />
          <span class="nav-text">Дашборд</span>
        </button>
        <button class=${view === "alerts" ? "on" : ""}
                title="Алерты"
                onClick=${() => { setView("alerts"); setSid(null); }}>
          <${NavIcon} name="alerts" />
          <span class="nav-text">Алерты</span>
          ${(alertCounts.critical + alertCounts.warning) > 0
            ? html`<span class=${"nav-badge " + (alertCounts.critical > 0 ? "" : "warn")}>${alertCounts.critical + alertCounts.warning}</span>`
            : null}
        </button>
        <button class=${view === "automation" ? "on" : ""}
                title="Автоматизация"
                onClick=${() => { setView("automation"); setSid(null); }}>
          <${NavIcon} name="automation" />
          <span class="nav-text">Автоматизация</span>
          ${pendingReactions > 0
            ? html`<span class="nav-badge warn" title="Открыть очередь реакций"
                           onClick=${(e) => { e.stopPropagation(); setPendingOpen(true); }}>${pendingReactions}</span>`
            : null}
        </button>
        <button class=${view === "audit" ? "on" : ""}
                title="Аудит"
                onClick=${() => { setView("audit"); setSid(null); }}>
          <${NavIcon} name="audit" />
          <span class="nav-text">Аудит</span>
        </button>
        <button class=${view === "set" ? "on" : ""}
                title="Настройки"
                onClick=${() => { setView("set"); setSid(null); }}>
          <${NavIcon} name="settings" />
          <span class="nav-text">Настройки</span>
        </button>
        <button title="Завершить сессию" onClick=${() => setLogoutOpen(true)}>
          <${NavIcon} name="logout" />
          <span class="nav-text">Выйти</span>
        </button>
      </nav>
    </header>
    <div class=${"view-host" + (sid ? " view-host--server" : "")}>
    ${(() => {
      // Баннер интернета. Всегда в DOM — видимость через класс .shown
      // на обёртке .banner-reveal (grid-template-rows 0fr → 1fr) даёт
      // плавное появление/исчезновение.
      //
      // Показываем в двух случаях:
      //   - status.internet_offline=true (нет интернета);
      //   - state="success" (последний клик был успешен — 3 сек зелёный).
      const showBanner = internetBannerShown;
      // Определяем kind, text и содержимое кнопки по state.
      //   idle      — жёлтый, «Проверить сейчас»
      //   checking  — жёлтый, спиннер в кнопке
      //   success   — зелёный, кнопка «Успешно» (disabled)
      //   fail      — красный, кнопка «Провал» (disabled)
      let kind = "warn";
      let text = "Нет подключения к интернету. Операции приостановлены.";
      let btnDisabled = false;
      let btnContent = "Проверить сейчас";
      let btnIsSpinner = false;
      if (internetBannerState === "checking") {
        kind = "warn";
        text = "Проверяю соединение…";
        btnDisabled = true;
        btnIsSpinner = true;
      } else if (internetBannerState === "success") {
        kind = "ok";
        text = "Соединение восстановлено.";
        btnDisabled = true;
        btnContent = "Успешно";
      } else if (internetBannerState === "fail") {
        kind = "danger";
        text = "Нет подключения к интернету. Операции приостановлены.";
        btnDisabled = true;
        btnContent = "Провал";
      }
      // stateForRender используется в key для перезапуска CSS-анимации
      // fade-in при смене состояния — текст и кнопка «проявляются» плавно,
      // а не меняются мгновенно.
      const stateForRender = internetBannerState;
      return html`<div class=${"banner-reveal" + (showBanner ? " shown" : "")}>
        <div class="banner-reveal-inner">
          <div class=${"banner banner--internet " + kind}>
            <div class="row">
              <span class="grow banner-text" key=${"t-" + stateForRender}>${text}</span>
              ${internetBannerState === "idle"
                && typeof internetNextCheckInSec === "number"
                && internetNextCheckInSec > 0
                ? html`<span class="banner-countdown"
                        title="Автоматическая проверка соединения"
                        key=${"c-" + internetNextCheckInSec}>
                    ${internetNextCheckInSec}с
                  </span>`
                : null}
              <button class="btn btn-sm banner-internet-btn"
                      disabled=${btnDisabled}
                      onClick=${doCheckInternet}>
                <span class="banner-btn-label" key=${"b-" + stateForRender}>
                  ${btnIsSpinner
                    ? html`<span class="spin" aria-label="проверка">⟳</span>`
                    : btnContent}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>`;
    })()}
    ${status?.no_audit ? html`<${Banner} kind="warn">Режим --no-audit: в audit_log ничего не пишется. Операции выполняются, цепочка не трогается.</${Banner}>` : null}
    ${integ && !integ.ok && integ.code !== "AUDIT_DISABLED" ? html`<${Banner} kind="danger">${integ.message}</${Banner}>` : null}
    ${view === "dash" && !sid ? html`<${Dashboard} llmEnabled=${!!status?.llm_enabled} internetOffline=${!!status?.internet_offline} onOpenAlerts=${() => setView("alerts")} onOpen=${(id) => (id === "new" ? setShowNew(true) : setSid(id))} />` : null}
    ${view === "alerts" && !sid ? html`<${AlertsView}
        llmEnabled=${!!status?.llm_enabled}
        initialDetailId=${pendingAlertId}
        onDetailClosed=${() => setPendingAlertId(null)}
        onOpenRule=${(rule) => {
          setView("automation");
          setSid(null);
          setPendingRuleRid(rule.id);
        }}
        onOpenServer=${(id) => { setSid(id); setView("dash"); }}
        onExplain=${(a) => {
          const text = [
            `Алерт на ${a.llm_alias || "server"} — ${a.title}.`,
            a.description ? `Описание: ${a.description}.` : "",
            `Severity: ${a.severity}, источник: ${a.source}.`,
            "",
            "Что может быть причиной и что стоит проверить?",
          ].filter(Boolean).join("\n");
          window.dispatchEvent(new CustomEvent("melecho:llm-ask", { detail: { text } }));
        }} />` : null}
    ${sid ? html`<${ServerView} id=${sid} internetOffline=${!!status?.internet_offline} onBack=${() => setSid(null)} />` : null}
    ${view === "automation" ? html`<${AutomationView}
        autoState=${autoState}
        pendingCount=${pendingReactions}
        onOpenPending=${() => setPendingOpen(true)}
        onRefreshStatus=${refreshStatus}
        initialRuleRid=${pendingRuleRid}
        onRuleDetailClosed=${() => setPendingRuleRid(null)} />` : null}
    ${view === "audit" ? html`<${AuditView} />` : null}
    ${view === "set" ? html`<${SettingsView} />` : null}
    </div>
    ${showNew
      ? html`<${NewServer} onClose=${() => setShowNew(false)} onCreated=${(s) => { setShowNew(false); setSid(s.id); }} />`
      : null}
    ${status?.llm_enabled ? html`<${LLMWindow} />` : null}
    ${pendingOpen
      ? html`<${PendingReactionsModal}
            onClose=${() => setPendingOpen(false)}
            onChanged=${refreshStatus} />`
      : null}
    ${inlineEditor
      ? html`<${UserOpEditor}
            mode="create"
            initialYaml=${inlineEditor.yaml}
            onClose=${() => setInlineEditor(null)}
            onSaved=${() => { setInlineEditor(null); refreshStatus(); }} />`
      : null}
    ${pendingAlertRules
      ? html`<${AlertRulesFromLLMModal}
            rules=${pendingAlertRules}
            onClose=${() => setPendingAlertRules(null)}
            onDone=${(n) => { setPendingAlertRules(null); refreshStatus(); }} />`
      : null}
    ${pendingReaction
      ? html`<${ReactionRuleEditor}
            initial=${llmReactionToEditorInitial(pendingReaction)}
            title="Новая реакция (из LLM)"
            onClose=${() => setPendingReaction(null)}
            onSaved=${() => { setPendingReaction(null); refreshStatus(); }} />`
      : null}
    ${pendingEditRule
      ? html`<${AlertRuleEditor}
            initial=${pendingEditRule.initial}
            title="Правка правила (из LLM)"
            onSubmit=${async (body) => {
              // PATCH правила. После сохранения — рефреш + закрыть.
              const rid = pendingEditRule.initial.id;
              await api("/api/v1/alert-rules/" + rid, {
                method: "PATCH", body: JSON.stringify(body),
              });
              showToast("Правило сохранено", "ok");
              setPendingEditRule(null);
              refreshStatus();
            }}
            onClose=${() => setPendingEditRule(null)} />`
      : null}
    ${logoutOpen
      ? html`<${Modal} title="Выйти?" onClose=${() => setLogoutOpen(false)}
          footer=${html`<div class="row">
            <button class="btn btn-sm btn-ghost" onClick=${() => setLogoutOpen(false)}>Отмена</button>
            <div class="grow"></div>
            <button class="btn btn-sm" onClick=${doLogoutProfile}>Выйти из профиля</button>
            <button class="btn btn-sm btn-danger" onClick=${doStopAndLogout}>Остановить и выйти</button>
          </div>`}>
          <p class="muted">
            <b>Выйти из профиля</b> — закрывает SSH-сессии, расшифрованный
            ключ удаляется из памяти, вы возвращаетесь на стартовый экран.
            Процесс backend продолжает работать — можно сразу войти в
            другой профиль или в этот же.
          </p>
          <p class="muted">
            <b>Остановить и выйти</b> — graceful shutdown: SSH-сессии закрываются,
            процесс завершается, runtime-файлы очищаются. Для возврата запустите
            <span class="mono"> melecho</span> заново.
          </p>
        </${Modal}>`
      : null}
    ${toastMsg
      ? html`<${Toast} kind=${toastMsg.kind} onDone=${() => setToastMsg(null)}>${toastMsg.text}</${Toast}>`
      : null}
  </div>`;
}

function Root() {
  const { role, note } = useTabRole();
  const [phase, setPhase] = useState("boot");
  const [status, setStatus] = useState(null);
  // Список профилей + активный. Загружается на afterSession. Нужен
  // только для стартовых экранов (unlock/wizard), в фазе app не
  // используется.
  const [profiles, setProfiles] = useState([]);
  const [activeSlug, setActiveSlug] = useState(null);
  // Флаг «идёт switch». Блокирует селект, чтобы пользователь не
  // дёргал его несколько раз, пока backend уже переключил профиль
  // и держит лок на reload.
  const [switchBusy, setSwitchBusy] = useState(false);

  async function afterSession() {
    const s = await api("/api/v1/system/status");
    setStatus(s);
    try {
      const p = await api("/api/v1/profiles");
      setProfiles(p.items || []);
      setActiveSlug(p.active_slug);
    } catch {
      // Не критично: панель работает и без списка профилей.
      setProfiles([]);
      setActiveSlug(null);
    }
    if (s.first_run) setPhase("wizard");
    else if (s.locked) setPhase("unlock");
    else setPhase("app");
  }

  // Переключение профиля. Специальность: старый session-токен инвалидируется
  // при switch, поэтому после ответа сразу делаем location.replace с новым
  // bootstrap-фрагментом. Старый sessionStorage НЕ должен пережить reload —
  // иначе Root увидит живой sessionToken, не пойдёт по фрагменту, и первый
  // же запрос с невалидным токеном уронит панель в need-boot.
  async function switchProfile(slug) {
    if (!slug || slug === activeSlug || switchBusy) return;
    setSwitchBusy(true);
    // Диагностический лог — переключение профиля критично, и мы хотим
    // видеть в консоли, где именно оно может застрять. Уйдёт из кода,
    // когда механизм отработает достаточно долго без сюрпризов.
    console.info("[switchProfile] start slug=%s", slug);
    // AbortController: если /profiles/switch не ответит за 20 сек —
    // считаем это ошибкой и отпускаем UI. Backend при этом может
    // продолжать reload; но пользователь хотя бы не залипнет.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), 20000);
    try {
      const r = await api("/api/v1/profiles/switch", {
        method: "POST",
        body: JSON.stringify({ slug }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      console.info("[switchProfile] response", r);
      if (r.noop) {
        setSwitchBusy(false);
        return;
      }
      if (!r.bootstrap) {
        setSwitchBusy(false);
        alert("Профиль переключён, но backend не вернул bootstrap. Запустите `melecho --status` для нового URL.");
        return;
      }
      sessionToken = "";
      try { sessionStorage.removeItem("melecho.session"); } catch {}
      // location.replace("/#bootstrap=X") НЕ перезагружает страницу,
      // если у нас уже URL вида /#bootstrap=Y: браузер видит, что
      // path+query совпадают, а изменился только фрагмент, и делает
      // hashchange вместо reload. Нам нужен именно reload — единственный
      // способ сбросить старый React-state (список профилей, фазу
      // unlock/wizard, живые SSE-коннекты, AppShell).
      //
      // Решение: добавить query-параметр `ps` (profile-switched). Он
      // делает URL отличающимся по path+query, гарантируя перезагрузку.
      // Фрагмент с bootstrap читается Root'ом отдельно от query — конфликта
      // нет. Значение — метка времени, чтобы URL отличался при каждом
      // переключении (на случай, если одно и то же X → Y → X).
      const newUrl = "/?ps=" + Date.now() + "#bootstrap=" + encodeURIComponent(r.bootstrap);
      console.info("[switchProfile] reload → %s", newUrl);
      location.replace(newUrl);
    } catch (ex) {
      clearTimeout(timer);
      console.error("[switchProfile] failed", ex);
      setSwitchBusy(false);
      alert("Не удалось переключить профиль: " + (ex && ex.message ? ex.message : ex));
    }
  }

  // Остановить backend с экрана unlock/wizard. Логика та же, что у
  // «Остановить и выйти» в AppShell: POST /session/logout с флагом
  // stop_backend → backend делает graceful shutdown → мы переходим в
  // phase=stopped. Сессия на этой стадии уже есть (Root получил её
  // через POST /session до phase=unlock/wizard).
  async function stopBackendFromGate() {
    try {
      await api("/api/v1/session/logout", {
        method: "POST",
        body: JSON.stringify({ stop_backend: true }),
      });
    } catch (e) { /* backend завершается, сеть сейчас отвалится */ }
    sessionToken = "";
    try { sessionStorage.removeItem("melecho.session"); } catch {}
    window.dispatchEvent(new CustomEvent("melecho:backend-stopped"));
  }

  // Создать новый профиль и сразу переключиться на него.
  async function createProfile(name) {
    const r = await api("/api/v1/profiles", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    // switchProfile внутри сам делает location.replace, поэтому
    // после успешного создания этот вызов не вернётся.
    await switchProfile(r.slug);
  }

  // Backend остановлен по кнопке «Остановить и выйти». Переходим
  // в phase=stopped — показываем экран с инструкцией запуска. Реального
  // «закрытия вкладки» браузер нам не даст, но экран вводит в курс дела.
  useEffect(() => {
    function onStopped() { setPhase("stopped"); }
    window.addEventListener("melecho:backend-stopped", onStopped);
    return () => window.removeEventListener("melecho:backend-stopped", onStopped);
  }, []);

  useEffect(() => {
    if (role !== "leader") return undefined;
    (async () => {
      try {
        if (!sessionToken) {
          const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
          let token = hash.get("bootstrap");
          if (!token) {
            try {
              const b = await fetch("/api/v1/dev/bootstrap").then((r) => (r.ok ? r.json() : null));
              token = b && b.token;
            } catch {
              token = null;
            }
          }
          if (!token) {
            setPhase("need-boot");
            return;
          }
          const sess = await api("/api/v1/session", { method: "POST", body: JSON.stringify({ token }) });
          sessionToken = sess.token;
          sessionStorage.setItem("melecho.session", sessionToken);
          history.replaceState(null, "", location.pathname);
        }
        await afterSession();
      } catch (ex) {
        sessionToken = "";
        sessionStorage.removeItem("melecho.session");
        try {
          const b = await fetch("/api/v1/dev/bootstrap").then((r) => (r.ok ? r.json() : null));
          if (!b || !b.token) {
            setPhase("need-boot");
            return;
          }
          const sess = await api("/api/v1/session", { method: "POST", body: JSON.stringify({ token: b.token }) });
          sessionToken = sess.token;
          sessionStorage.setItem("melecho.session", sessionToken);
          history.replaceState(null, "", location.pathname);
          await afterSession();
        } catch {
          setPhase("need-boot");
        }
      }
    })();
    return undefined;
  }, [role]);

  if (role === "checking") return html`<${Gate} title="Проверка вкладки"><p class="muted">BroadcastChannel…</p></${Gate}>`;
  if (role === "follower") return html`<${Gate} title="Уже открыто"><p>${note}</p></${Gate}>`;
  if (phase === "stopped")
    return html`<${Gate} title="Melecho остановлен" subtitle="Процесс backend завершён по запросу из интерфейса.">
      <div class="stack">
        <p>Чтобы запустить снова:</p>
        <code class="cmd">melecho</code>
        <p class="muted">
          Из репозитория: <code class="cmd">./run.sh</code>.<br />
          Проверить статус: <code class="cmd">melecho --status</code>.
        </p>
      </div>
    </${Gate}>`;
  if (phase === "need-boot")
    return html`<${Gate} title="Сессия потеряна" subtitle="Backend перезапущен или последняя вкладка закрыта — токен больше не действует.">
      <div class="stack">
        <p>Как восстановить:</p>
        <ol class="muted" style="padding-left:1.2em">
          <li>Откройте терминал, где запущен backend (<code>./run.sh</code>).</li>
          <li>Найдите строку с URL вида <code>http://127.0.0.1:8765/#bootstrap=…</code>.</li>
          <li>Откройте его в этой вкладке.</li>
        </ol>
        <p class="muted">Если URL уже нет в выводе — пошлите процессу SIGUSR1:<br/><code>kill -USR1 ${"<pid>"}</code><br/>Backend напечатает свежий URL в stdout.</p>
      </div>
    </${Gate}>`;
  if (phase === "wizard") return html`<${Wizard}
      onDone=${() => setPhase("app")}
      profiles=${profiles}
      activeSlug=${activeSlug}
      onSwitchProfile=${switchProfile}
      onCreateProfile=${createProfile}
      switchBusy=${switchBusy}
      onStopBackend=${stopBackendFromGate} />`;
  if (phase === "unlock") return html`<${Unlock}
      onDone=${() => setPhase("app")}
      profiles=${profiles}
      activeSlug=${activeSlug}
      onSwitchProfile=${switchProfile}
      onCreateProfile=${createProfile}
      switchBusy=${switchBusy}
      onStopBackend=${stopBackendFromGate} />`;
  if (phase === "app") return html`<${AppShell} />`;
  return html`<${Gate} title="Melecho"><p class="muted">Загрузка…</p></${Gate}>`;
}

render(html`<${Root} />`, document.getElementById("app"));
