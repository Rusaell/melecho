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

// Преобразование Python-именованных групп (?P<name>...) в JS (?<name>...)
// и безопасная компиляция multiline RegExp.
function compileDisplayRegex(pat) {
  if (typeof pat !== "string" || !pat) return null;
  const jsPat = pat.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>");
  try {
    return new RegExp(jsPat, "m");
  } catch {
    return null;
  }
}

function getJsonPath(obj, path) {
  if (obj == null) return undefined;
  if (!path) return obj;
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

// Безопасный вычислитель арифметических выражений (без eval/Function для CSP).
// Поддерживает идентификаторы из row, числа, +, -, *, /, скобки.
function evalDisplayExpr(expr, row) {
  if (typeof expr !== "string" || !expr.trim()) return null;
  const tokens = [];
  const rx = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[+\-*/()])/g;
  let pos = 0;
  while (pos < expr.length) {
    rx.lastIndex = pos;
    const m = rx.exec(expr);
    if (!m || m.index !== pos) {
      if (expr.slice(pos).trim() === "") break;
      return null;
    }
    tokens.push(m[1]);
    pos = rx.lastIndex;
  }
  if (!tokens.length) return null;
  let i = 0;
  function parseExpr() {
    let left = parseTerm();
    if (left == null) return null;
    while (i < tokens.length && (tokens[i] === "+" || tokens[i] === "-")) {
      const op = tokens[i++];
      const right = parseTerm();
      if (right == null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    if (left == null) return null;
    while (i < tokens.length && (tokens[i] === "*" || tokens[i] === "/")) {
      const op = tokens[i++];
      const right = parseFactor();
      if (right == null) return null;
      if (op === "/") {
        if (right === 0) return 0;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }
  function parseFactor() {
    if (i >= tokens.length) return null;
    const tok = tokens[i++];
    if (tok === "(") {
      const v = parseExpr();
      if (tokens[i] !== ")") return null;
      i++;
      return v;
    }
    if (tok === "-") {
      const v = parseFactor();
      return v == null ? null : -v;
    }
    if (/^\d/.test(tok)) return Number(tok);
    const raw = row && row[tok];
    const num = Number(raw);
    return raw == null || Number.isNaN(num) ? null : num;
  }
  const res = parseExpr();
  return i === tokens.length && Number.isFinite(res) ? res : null;
}

function formatDisplayCell(val, format) {
  if (val == null || val === "") return "—";
  if (format === "bytes") return fmtBytes(val);
  if (format === "percent") {
    const n = Number(val);
    return Number.isNaN(n) ? "—" : n.toFixed(1) + "%";
  }
  if (format === "number") {
    const n = Number(val);
    return Number.isNaN(n) ? String(val) : String(n);
  }
  return String(val);
}

function kvSeverityClass(valStr, field) {
  const s = String(valStr ?? "");
  for (const [key, cls] of [["danger_if", "err"], ["warn_if", "cell-warn"], ["ok_if", "okt"]]) {
    if (field[key]) {
      const rx = compileDisplayRegex(field[key]);
      if (rx && rx.test(s)) return cls;
    }
  }
  return "";
}

function DisplaySingleBlock({ spec, stdout }) {
  if (!spec || typeof spec !== "object") return null;
  const text = String(stdout ?? "");

  if (spec.type === "lines") {
    const lines = text.split(/\r?\n/);
    const incRx = (spec.include || []).map(compileDisplayRegex).filter(Boolean);
    const excRx = (spec.exclude || []).map(compileDisplayRegex).filter(Boolean);
    const matched = lines.filter((ln) => {
      if (!ln.trim() && incRx.length) return false;
      if (incRx.length && !incRx.some((rx) => rx.test(ln))) return false;
      if (excRx.length && excRx.some((rx) => rx.test(ln))) return false;
      return true;
    });
    return html`<div class="stack" style="gap:6px">
      ${spec.title ? html`<div class="form-section-title">${spec.title}</div>` : null}
      ${matched.length === 0
        ? html`<div class="muted small">${spec.empty_text || "Совпадений по фильтру не найдено."}</div>`
        : html`<pre class="pre" style="margin:0">${matched.join("\n")}</pre>`}
    </div>`;
  }

  if (spec.type === "kv") {
    const fmt = spec.format || "regex";
    const rows = [];
    if (fmt === "json") {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (!parsed || typeof parsed !== "object") {
        return html`<div class="stack" style="gap:6px">
          ${spec.title ? html`<div class="form-section-title">${spec.title}</div>` : null}
          <div class="muted small">Не удалось разобрать вывод как JSON.</div>
        </div>`;
      }
      for (const f of (spec.fields || [])) {
        const val = getJsonPath(parsed, f.key);
        const formatted = formatDisplayCell(val, f.format);
        rows.push({ label: f.label, val: formatted, cls: kvSeverityClass(formatted, f), mono: f.format === "mono" });
      }
    } else {
      for (const f of (spec.fields || [])) {
        const rx = compileDisplayRegex(f.regex);
        let extracted = null;
        if (rx) {
          const m = rx.exec(text);
          if (m) {
            const grp = f.group != null ? Number(f.group) : (m.length > 1 ? 1 : 0);
            extracted = m[grp] != null ? String(m[grp]).trim() : null;
          }
        }
        if (extracted != null) {
          const formatted = formatDisplayCell(extracted, f.format);
          rows.push({ label: f.label, val: formatted, cls: kvSeverityClass(formatted, f), mono: f.format === "mono" || !f.format });
        }
      }
    }
    return html`<div class="stack" style="gap:6px">
      ${spec.title ? html`<div class="form-section-title">${spec.title}</div>` : null}
      ${rows.length === 0
        ? html`<div class="muted small">${spec.empty_text || "Данные по шаблону не найдены."}</div>`
        : html`<dl class="alert-detail-meta">
            ${rows.map((r, idx) => html`<dt key=${"dt" + idx}>${r.label}</dt>
              <dd key=${"dd" + idx} class=${(r.mono ? "mono " : "") + r.cls}>${r.val}</dd>`)}
          </dl>`}
    </div>`;
  }

  if (spec.type === "table") {
    const fmt = spec.format || "json";
    const cols = spec.columns || [];
    let allRows = [];
    let parseErr = "";

    if (fmt === "json") {
      let data = null;
      try { data = JSON.parse(text); } catch { parseErr = "Не удалось разобрать вывод как JSON."; }
      if (data != null) {
        const rootArr = spec.items_path ? getJsonPath(data, spec.items_path) : data;
        if (!Array.isArray(rootArr)) {
          parseErr = "В JSON не найден ожидаемый массив данных.";
        } else {
          const walk = (arr) => {
            for (const item of (arr || [])) {
              if (!item || typeof item !== "object") continue;
              allRows.push(item);
              if (spec.children_key && Array.isArray(item[spec.children_key])) {
                walk(item[spec.children_key]);
              }
            }
          };
          walk(rootArr);
        }
      }
    } else {
      const rx = compileDisplayRegex(spec.regex);
      if (!rx) {
        parseErr = "Некорректный regex в display.";
      } else {
        const lines = text.split(/\r?\n/).slice(spec.skip_lines || 0);
        for (const ln of lines) {
          if (!ln.trim()) continue;
          const m = rx.exec(ln);
          if (!m) continue;
          if (m.groups) {
            const cleanObj = {};
            for (const [gk, gv] of Object.entries(m.groups)) {
              cleanObj[gk] = gv != null ? String(gv).trim() : "";
            }
            allRows.push(cleanObj);
          } else {
            const rowObj = {};
            cols.forEach((c, idx) => { rowObj[c.key] = m[idx + 1] ?? ""; });
            allRows.push(rowObj);
          }
        }
      }
    }

    if (parseErr) {
      return html`<div class="stack" style="gap:6px">
        ${spec.title ? html`<div class="form-section-title">${spec.title}</div>` : null}
        <div class="muted small">${parseErr}</div>
      </div>`;
    }

    const enriched = allRows.map((raw) => {
      const r = { ...raw };
      for (const c of cols) {
        if (c.expr) r[c.key] = evalDisplayExpr(c.expr, r);
      }
      return r;
    });

    let mainRows = enriched;
    let otherRows = [];
    if (spec.filter_in && typeof spec.filter_in === "object") {
      mainRows = [];
      for (const r of enriched) {
        const ok = Object.entries(spec.filter_in).every(([k, allowed]) =>
          Array.isArray(allowed) && allowed.includes(String(r[k] ?? ""))
        );
        if (ok) mainRows.push(r);
        else otherRows.push(r);
      }
    }

    const renderTable = (rowsList) => html`<div class="table-wrap">
      <table class="no-last-border">
        <thead>
          <tr>${cols.map((c) => html`<th key=${c.key}>${c.label}</th>`)}</tr>
        </thead>
        <tbody>
          ${rowsList.map((r, rIdx) => html`<tr key=${rIdx}>
            ${cols.map((c) => {
              const rawVal = r[c.key];
              const num = Number(rawVal);
              let cls = c.format === "mono" ? "mono" : "";
              if (rawVal != null && !Number.isNaN(num)) {
                if (c.danger_gt != null && num > Number(c.danger_gt)) cls += " err";
                else if (c.warn_gt != null && num > Number(c.warn_gt)) cls += " cell-warn";
              }
              return html`<td key=${c.key} class=${cls.trim()}>${formatDisplayCell(rawVal, c.format)}</td>`;
            })}
          </tr>`)}
        </tbody>
      </table>
    </div>`;

    return html`<div class="stack" style="gap:6px">
      ${spec.title ? html`<div class="form-section-title">${spec.title}</div>` : null}
      ${mainRows.length === 0
        ? html`<div class="muted small">${spec.empty_text || "Записей не найдено."}</div>`
        : renderTable(mainRows)}
      ${otherRows.length > 0 && spec.other_summary
        ? html`<details>
            <summary class="muted small">${spec.other_summary} (${otherRows.length})</summary>
            ${renderTable(otherRows)}
          </details>`
        : null}
    </div>`;
  }

  return null;
}

function OperationDisplayView({ display, steps, stdout }) {
  if (!display) return null;
  const runSteps = Array.isArray(steps) ? steps.filter((st) => st.phase === "run") : null;

  function pickStdout(stepIdx) {
    if (runSteps && runSteps.length > 0) {
      const idx = stepIdx != null
        ? (stepIdx < 0 ? runSteps.length + stepIdx : stepIdx)
        : (runSteps.length - 1);
      const chosen = runSteps[idx] || runSteps[runSteps.length - 1];
      return chosen ? (chosen.stdout || "") : "";
    }
    return stdout || "";
  }

  if (display.type === "sections") {
    const secs = Array.isArray(display.sections) ? display.sections : [];
    return html`<div class="stack" style="gap:12px">
      ${secs.map((sec, idx) => html`<div key=${idx} class="form-section">
        <${DisplaySingleBlock} spec=${sec} stdout=${pickStdout(sec.step)} />
      </div>`)}
    </div>`;
  }

  return html`<${DisplaySingleBlock} spec=${display} stdout=${pickStdout(display.step)} />`;
}

function OperationResultView({ op, steps, stdout, stderr, exitCode }) {
  const disp = op && op.display;
  const hasSteps = Array.isArray(steps) && steps.length > 0;
  const rawBlock = hasSteps
    ? steps.map((s, idx) => html`<pre class="pre" key=${idx}>${s.phase} exit ${s.exit}
${s.stdout}${s.stderr}</pre>`)
    : html`<div class="stack">
        ${stdout ? html`<pre class="pre">${stdout}</pre>` : null}
        ${stderr ? html`<div class="form-section-title">stderr</div><pre class="pre">${stderr}</pre>` : null}
        ${!stdout && !stderr ? html`<p class="muted">Вывод команды не сохранён (пустой или уже очищен).</p>` : null}
      </div>`;

  if (!disp) return rawBlock;

  return html`<div class="stack">
    <${OperationDisplayView} display=${disp} steps=${steps} stdout=${stdout} />
    <details>
      <summary class="muted small">Полный вывод команды</summary>
      <div class="stack" style="margin-top:8px">${rawBlock}</div>
    </details>
  </div>`;
}

function SshKeyPathField({ value, onChange, disabled }) {
  const [keysInfo, setKeysInfo] = useState({ profile_keys: [], local_keys: [] });
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState("");
  const fileRef = useRef(null);

  async function loadKeys() {
    try {
      const r = await api("/api/v1/ssh-keys");
      setKeysInfo({
        profile_keys: r.profile_keys || [],
        local_keys: r.local_keys || [],
      });
    } catch {}
  }

  useEffect(() => { loadKeys(); }, []);

  async function onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUpErr("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/v1/ssh-keys/upload", {
        method: "POST",
        headers: { "X-Session-Token": sessionToken },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || "Ошибка загрузки ключа");
      }
      onChange(data.ref);
      await loadKeys();
      showToast("Ключ зашифрован и сохранён в профиле", "ok");
    } catch (ex) {
      setUpErr(ex.message || String(ex));
    } finally {
      setUploading(false);
    }
  }

  const isProfileKey = typeof value === "string" && value.startsWith("profile:keys/");

  return html`<div class="stack" style="gap:6px">
    <div class="row" style="align-items:center; justify-content:space-between">
      <label style="margin:0">
        Файл ключа
        ${isProfileKey ? html` <span class="badge ok" title="Ключ зашифрован DEK в каталоге профиля">🔒 в профиле</span>` : null}
      </label>
      <button type="button" class="btn btn-sm"
              disabled=${disabled || uploading}
              onClick=${() => fileRef.current && fileRef.current.click()}>
        ${uploading ? "Загрузка…" : "Загрузить в профиль…"}
      </button>
      <input type="file" ref=${fileRef} style="display:none" onChange=${onFilePicked} />
    </div>
    <input class="mono"
           placeholder="/home/you/.ssh/id_ed25519 или загрузите файл"
           value=${value || ""}
           disabled=${disabled || uploading}
           onInput=${(e) => onChange(e.target.value)} />
    ${upErr ? html`<div class="err small">${upErr}</div>` : null}
    ${(keysInfo.profile_keys.length > 0 || keysInfo.local_keys.length > 0)
      ? html`<div class="preset-pills">
          ${keysInfo.profile_keys.map((k) => html`<button type="button" key=${k.ref}
              class=${"preset-pill" + (value === k.ref ? " on" : "")}
              title=${"Зашифрованный ключ профиля: " + k.ref}
              onClick=${() => onChange(k.ref)}>🔒 ${k.name}</button>`)}
          ${keysInfo.local_keys.map((k) => html`<button type="button" key=${k.path}
              class=${"preset-pill" + (value === k.path ? " on" : "")}
              title=${k.path}
              onClick=${() => onChange(k.path)}>📁 ${k.name}</button>`)}
        </div>`
      : null}
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
          ? html`<${SshKeyPathField} value=${form.key_path} onChange=${(v) => setField("key_path", v)} />
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

function StreamExecModal({ job, op, onClose }) {
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [doneInfo, setDoneInfo] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const preRef = useRef(null);

  useEffect(() => {
    if (doneInfo) return undefined;
    const t0 = Date.now();
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - t0) / 1000));
    }, 500);
    return () => clearInterval(iv);
  }, [job.job_id, !!doneInfo]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stdout, stderr]);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await fetch("/api/v1/operations/stream/" + encodeURIComponent(job.job_id), {
          headers: sessionToken ? { "X-Session-Token": sessionToken } : {},
          signal: ctrl.signal,
        });
        if (!r.ok || !r.body) {
          throw new Error("HTTP " + r.status);
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
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
              if (obj.type === "chunk") {
                if (obj.stream === "stderr") setStderr((p) => p + (obj.text || ""));
                else setStdout((p) => p + (obj.text || ""));
              } else if (obj.type === "done") {
                if (obj.stdout != null) setStdout(obj.stdout);
                if (obj.stderr != null) setStderr(obj.stderr);
                setDoneInfo(obj);
              }
            }
          }
        }
      } catch (ex) {
        if (ex && ex.name !== "AbortError") setErr(ex.message || String(ex));
      }
    })();
    return () => { try { ctrl.abort(); } catch {} };
  }, [job.job_id]);

  async function stopStream() {
    setStopping(true);
    try {
      await api("/api/v1/operations/stream/" + encodeURIComponent(job.job_id) + "/stop", {
        method: "POST",
        body: "{}",
      });
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setStopping(false);
    }
  }

  return html`<${Modal}
      title=${(op ? op.name : job.oid) + " · поток"}
      onClose=${() => { if (!doneInfo) stopStream(); onClose(); }}
      footer=${html`<div class="row">
        <span class="muted small grow">
          ${doneInfo
            ? `Завершено · exit ${doneInfo.exit} · ${doneInfo.duration_ms} мс${doneInfo.interrupted ? " · остановлено" : ""}`
            : `Выполняется · ${elapsed}с (макс. ${job.max_duration_sec}с)`}
        </span>
        ${!doneInfo
          ? html`<button type="button" class="btn btn-sm btn-danger"
                    disabled=${stopping}
                    onClick=${stopStream}>
                ${stopping ? "Остановка…" : "Остановить (Ctrl+C)"}
              </button>`
          : html`<button type="button" class="btn btn-sm btn-primary" onClick=${onClose}>Закрыть</button>`}
      </div>`}>
    ${err ? html`<div class="err">${err}</div>` : null}
    ${doneInfo && op && op.display
      ? html`<${OperationResultView}
            op=${op}
            stdout=${doneInfo.stdout ?? stdout}
            stderr=${doneInfo.stderr ?? stderr}
            exitCode=${doneInfo.exit} />`
      : html`<div class="stack">
          <pre ref=${preRef} class="pre stream-pre">${stdout || (doneInfo ? "(вывод пуст)" : "Ожидание вывода…")}</pre>
          ${stderr ? html`<div class="form-section-title">stderr</div><pre class="pre">${stderr}</pre>` : null}
        </div>`}
  </${Modal}>`;
}

function ServerView({ id, onBack, internetOffline, llmEnabled }) {
  const [tab, setTab] = useState("overview");
  const [srv, setSrv] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [ops, setOps] = useState([]);
  const [services, setServices] = useState(null);
  const [plan, setPlan] = useState(null);
  const [exec, setExec] = useState(null);
  const [streamExec, setStreamExec] = useState(null);
  const [tofu, setTofu] = useState(null);
  const [sudo, setSudo] = useState(null);
  const [err, setErr] = useState("");
  const [opParams, setOpParams] = useState({});
  const [opsFilter, setOpsFilter] = useState("applicable");
  const [useSudo, setUseSudo] = useState(false);
  const [lines, setLines] = useState(100);
  const [svcQ, setSvcQ] = useState("");
  const [svcPage, setSvcPage] = useState(1);
  const [svcFilter, setSvcFilter] = useState("all");
  const [svcBusy, setSvcBusy] = useState(false);
  const [svcErr, setSvcErr] = useState("");
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
  const [metricsCfg, setMetricsCfg] = useState({ interval: "", raw_days: "", agg_days: "" });
  const [metricsCfgBusy, setMetricsCfgBusy] = useState(false);

  async function load() {
    const s = await api("/api/v1/servers/" + id);
    setSrv(s);
    setNameDraft(s.name || "");
    setAllowedSet(new Set(s.allowed_units || []));
    setAllowedDirty(false);
    setOps((await api("/api/v1/operations?server_id=" + id)).items);
  }
  // Фоновое обновление метаданных сервера (статус, last_seen_at, anomaly,
  // collect_error). Не трогает nameDraft и allowedSet — не теряем правки.
  async function refreshServerMeta() {
    try {
      const s = await api("/api/v1/servers/" + id);
      setSrv(s);
    } catch {}
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
    loadMetrics().catch((e) => setErr(e.message));
    const iv = setInterval(() => {
      loadMetrics().catch(() => {});
      refreshServerMeta();
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
    setMetricsCfg({
      interval: srv.metrics_interval_sec != null ? String(srv.metrics_interval_sec) : "",
      raw_days: srv.retention_raw_days != null ? String(srv.retention_raw_days) : "",
      agg_days: srv.retention_agg_days != null ? String(srv.retention_agg_days) : "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, srv && srv.id]);

  // SSE: новая точка метрики или событие алерта → обновляем графики и статус сервера.
  useEffect(() => {
    let timer = null;
    const onMetric = (e) => {
      const p = e && e.detail && e.detail.payload;
      if (!p || p.server_id !== Number(id)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadMetrics().catch(() => {});
        refreshServerMeta();
      }, 400);
    };
    const onAlert = (e) => {
      const p = e && e.detail && e.detail.payload;
      if (p && p.server_id != null && p.server_id !== Number(id)) return;
      refreshServerMeta();
    };
    window.addEventListener("melecho:metric-event", onMetric);
    window.addEventListener("melecho:alert-event", onAlert);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("melecho:metric-event", onMetric);
      window.removeEventListener("melecho:alert-event", onAlert);
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
    const opObj = ops.find((o) => o.id === plan.oid);
    const isStream = !!(opObj && opObj.flags && opObj.flags.streaming);
    try {
      const body = {
        server_id: Number(id),
        params: plan.params,
        confirm: true,
      };
      if (plan.escalatable || plan.use_sudo) body.use_sudo = plan.use_sudo;
      if (isStream) {
        const job = await api("/api/v1/operations/" + plan.oid + "/stream/start", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setStreamExec({ ...job, oid: plan.oid, op: opObj });
        setPlan(null);
      } else {
        const r = await api("/api/v1/operations/" + plan.oid + "/execute", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setExec(Object.assign({}, r, { _oid: plan.oid }));
        setPlan(null);
      }
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

  async function loadServices(page, filterOverride, qOverride) {
    const p = page || 1;
    const f = filterOverride !== undefined ? filterOverride : svcFilter;
    const qVal = qOverride !== undefined ? qOverride : svcQ;
    const qs = new URLSearchParams({
      per_page: "50",
      page: String(p),
      filter: f,
    });
    if (qVal && qVal.trim()) qs.set("q", qVal.trim());
    setSvcBusy(true);
    setSvcErr("");
    try {
      const r = await api("/api/v1/servers/" + id + "/services?" + qs.toString());
      setServices(r);
      setSvcPage(r.page);
    } catch (ex) {
      setSvcErr(ex.message);
    } finally {
      setSvcBusy(false);
    }
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
      await loadServices(svcPage);
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

  function fmtMetricVal(metric, val) {
    if (val == null) return "—";
    if (metric === "cpu" || metric === "ram" || metric === "disk") return fmtNum(val, 1) + "%";
    if (metric === "net_rx_bps" || metric === "net_tx_bps") return fmtBytes(val) + "/с";
    return fmtNum(val, 2);
  }

  function fmtAnomalyText(a) {
    const valStr = fmtMetricVal(a.metric, a.value);
    const parts = [];
    if (a.reason === "zscore" || a.reason === "both") {
      const sign = a.z_score >= 0 ? "+" : "";
      parts.push(`норма ~${fmtMetricVal(a.metric, a.ewma)}, отклонение ${sign}${fmtNum(a.z_score, 2)}σ`);
    }
    if ((a.reason === "threshold" || a.reason === "both") && a.abs_threshold != null) {
      parts.push(`порог ≥ ${fmtMetricVal(a.metric, a.abs_threshold)}`);
    }
    if (!parts.length) parts.push("отклонение от нормы");
    return `${a.label}: ${valStr} (${parts.join("; ")})`;
  }

  function askServerAnomalyInLLM() {
    if (!srv) return;
    const list = srv.anomalies || [];
    const lines = [
      `Сервер: ${srv.llm_alias}`,
      `ОС: ${srv.os_family}`,
      srv.nproc ? `CPU ядер: ${srv.nproc}` : null,
      list.length
        ? "Зафиксированные аномалии:\n" + list.map((a) => "  - " + fmtAnomalyText(a)).join("\n")
        : "Статус: аномалия (подробности не зафиксированы)",
    ].filter(Boolean);
    window.dispatchEvent(new CustomEvent("melecho:llm-attach", {
      detail: {
        name: `anomaly: ${srv.llm_alias}`,
        content: lines.join("\n"),
        force_mode: "chat",
      },
    }));
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
  async function doSaveMetricsCfg() {
    if (!srv) return;
    setErr("");
    setMetricsCfgBusy(true);
    try {
      const parseOptInt = (v) => (String(v ?? "").trim() === "" ? null : Number(v));
      const body = {
        metrics_interval_sec: parseOptInt(metricsCfg.interval),
        retention_raw_days: parseOptInt(metricsCfg.raw_days),
        retention_agg_days: parseOptInt(metricsCfg.agg_days),
      };
      const updated = await api("/api/v1/servers/" + id, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSrv(updated);
      setMetricsCfg({
        interval: updated.metrics_interval_sec != null ? String(updated.metrics_interval_sec) : "",
        raw_days: updated.retention_raw_days != null ? String(updated.retention_raw_days) : "",
        agg_days: updated.retention_agg_days != null ? String(updated.retention_agg_days) : "",
      });
      showToast("Настройки сбора и хранения сохранены", "ok");
    } catch (ex) {
      setErr(ex.message);
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setMetricsCfgBusy(false);
    }
  }

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
    ["graph", "Граф"],
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
          </div>
        </div>
        <div class="tabs">
          ${tabs.map(([k, l]) => html`<button class=${tab === k ? "on" : ""} onClick=${() => { setTab(k); if (k === "services") loadServices(1); }}>${l}</button>`)}
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
      ${srv && srv.anomaly
        ? html`<div class="banner danger">
            <div class="row">
              <div class="grow stack" style="gap:4px">
                <b>⚠ Зафиксирована аномалия</b>
                <div class="small">
                  ${(srv.anomalies && srv.anomalies.length)
                    ? srv.anomalies.map((a, idx) => html`<div key=${a.metric || idx}>• ${fmtAnomalyText(a)}</div>`)
                    : "Отклонение от нормы (подробности обновятся после следующего сбора)."}
                </div>
              </div>
              ${llmEnabled
                ? html`<button class="btn btn-sm" onClick=${askServerAnomalyInLLM}>↗ Спросить LLM</button>`
                : null}
            </div>
          </div>`
        : null}
      ${srv && srv.collect_error && !srv.collect_error.startsWith("E_HOSTKEY") && !(!!internetOffline && !srv.is_local)
        ? html`<div class="banner warn">${srv.collect_error}</div>`
        : null}
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
      ? (() => {
          const cnt = (services && services.counts) || null;
          const total = services ? services.total : 0;
          const totalPages = Math.max(1, Math.ceil(total / 50));
          const savedAllowed = new Set((srv && srv.allowed_units) || []);
          const canRestart = ops.some((o) => o.id === "systemd_restart" && o.valid);
          return html`<div class="stack">
            <div class="card stack">
              <div class="row">
                <div class="grow">
                  <h3>Системные сервисы и белый список</h3>
                  <p class="muted small">
                    Отметьте systemd-юниты, разрешённые в параметрах операций, проверок
                    и реакций (<span class="mono">server.allowed_units</span>). При сохранении
                    каждый юнит проверяется через <span class="mono">systemctl cat</span>.
                  </p>
                </div>
                <button class="btn btn-sm" disabled=${svcBusy} onClick=${() => loadServices(svcPage)}>
                  ${svcBusy ? "Обновление…" : "Обновить"}
                </button>
              </div>
              <div class="row">
                <${Segmented}
                  value=${svcFilter}
                  onChange=${(next) => { setSvcFilter(next); loadServices(1, next, svcQ); }}
                  options=${[
                    { value: "all", label: cnt ? `Все (${cnt.all})` : "Все" },
                    { value: "allowed", label: `Разрешённые (${allowedSet.size})` },
                    { value: "active", label: cnt ? `Активные (${cnt.active})` : "Активные" },
                    { value: "failed", label: cnt ? `Упавшие (${cnt.failed})` : "Упавшие" },
                  ]} />
              </div>
              <form class="row" onSubmit=${(e) => { e.preventDefault(); loadServices(1, svcFilter, svcQ); }}>
                <input class="grow" placeholder="Поиск по имени юнита (например nginx)"
                       value=${svcQ}
                       onInput=${(e) => setSvcQ(e.target.value)} />
                <button type="submit" class="btn btn-sm" disabled=${svcBusy}>Найти</button>
                ${(svcQ || svcFilter !== "all")
                  ? html`<button type="button" class="btn btn-sm btn-ghost" disabled=${svcBusy}
                          onClick=${() => { setSvcQ(""); setSvcFilter("all"); loadServices(1, "all", ""); }}>
                      Сбросить
                    </button>`
                  : null}
              </form>
              ${allowedDirty
                ? html`<div class="banner warn">
                    <div class="row">
                      <span class="grow">Есть несохранённые изменения (выбрано в списке: <b>${allowedSet.size}</b>).</span>
                      <button class="btn btn-sm btn-primary" disabled=${savingUnits} onClick=${saveAllowedUnits}>
                        ${savingUnits ? "Сохранение…" : "Сохранить изменения"}
                      </button>
                      <button class="btn btn-sm btn-ghost" disabled=${savingUnits} onClick=${cancelAllowed}>Отменить</button>
                    </div>
                  </div>`
                : null}
              ${svcErr ? html`<div class="err">${svcErr}</div>` : null}
            </div>

            <div class="card stack">
              ${!services && svcBusy
                ? html`<p class="muted">Загрузка списка сервисов…</p>`
                : (services && services.items && services.items.length === 0)
                ? html`<p class="muted">Подходящих сервисов не найдено.</p>`
                : html`<div class="table-wrap">
                    <table class="services-table no-last-border">
                      <thead>
                        <tr>
                          <th style="width:36px"></th>
                          <th>Юнит</th>
                          <th>Статус</th>
                          <th style="text-align:right">Действие</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${(services?.items || []).map((u) => {
                          const isFailed = u.active === "failed" || u.sub === "failed";
                          const isRunning = u.active === "active" && u.sub === "running";
                          const isActive = u.active === "active";
                          const statusCls = isFailed ? "danger" : (isRunning ? "ok" : (isActive ? "warn" : ""));
                          const statusText = [u.active, u.sub].filter(Boolean).join(" · ") || "—";
                          const isChecked = allowedSet.has(u.unit);
                          const isSaved = savedAllowed.has(u.unit);
                          return html`<tr key=${u.unit}>
                            <td>
                              <input type="checkbox" checked=${isChecked}
                                     onChange=${(e) => toggleUnit(u.unit, e.target.checked)} />
                            </td>
                            <td>
                              <div class="mono">${u.unit}</div>
                              ${u.load && u.load !== "loaded"
                                ? html`<div class="muted small">${u.load}</div>`
                                : null}
                            </td>
                            <td>
                              <span class=${"badge " + statusCls}>${statusText}</span>
                            </td>
                            <td style="text-align:right">
                              ${isSaved && canRestart
                                ? html`<button type="button" class="btn btn-sm btn-ghost"
                                          title="Открыть план операции systemd_restart"
                                          onClick=${() => doPlan("systemd_restart", { unit: u.unit }, false)}>
                                    Перезапуск
                                  </button>`
                                : (isChecked && !isSaved
                                    ? html`<span class="muted small">сохраните</span>`
                                    : null)}
                            </td>
                          </tr>`;
                        })}
                      </tbody>
                    </table>
                  </div>`}
              ${services
                ? html`<div class="row">
                    <span class="muted small grow">
                      Найдено: ${total} · стр. ${svcPage} из ${totalPages}
                    </span>
                    ${total > 50
                      ? html`<div class="row" style="gap:6px">
                          <button class="btn btn-sm" disabled=${svcBusy || svcPage <= 1}
                                  onClick=${() => loadServices(svcPage - 1)}>← Назад</button>
                          <button class="btn btn-sm" disabled=${svcBusy || svcPage * 50 >= total}
                                  onClick=${() => loadServices(svcPage + 1)}>Вперёд →</button>
                        </div>`
                      : null}
                  </div>`
                : null}
            </div>
          </div>`;
        })()
      : null}
    ${tab === "ops"
      ? (() => {
          const validOps = ops.filter((o) => o.valid);
          const shownOps = validOps.filter((o) => {
            if (opsFilter === "applicable") return o.applicable !== false;
            if (opsFilter === "user") return o.source === "user";
            return true;
          });
          const appCnt = validOps.filter((o) => o.applicable !== false).length;
          const userCnt = validOps.filter((o) => o.source === "user").length;
          return html`<div class="stack">
          <div class="row">
            <${Segmented}
              value=${opsFilter}
              onChange=${setOpsFilter}
              options=${[
                { value: "applicable", label: `Применимые (${appCnt})` },
                { value: "user", label: `Пользовательские (${userCnt})` },
                { value: "all", label: `Все (${validOps.length})` },
              ]} />
          </div>
          <datalist id="allowed-units-datalist">
            ${Array.from(allowedSet).sort().map((u) => html`<option value=${u} key=${u} />`)}
          </datalist>
          ${shownOps.length === 0
            ? html`<div class="card empty">
                <h3>Подходящих операций нет</h3>
                <p class="muted">Пользовательские операции привязываются к серверу в разделе «Автоматизация → Операции».</p>
              </div>`
            : html`<div class="grid">
            ${shownOps.map((o) => {
              const specs = Array.isArray(o.params) ? o.params : [];
              const curMap = opParams[o.id] || {};
              const setOpField = (pName, pVal) => setOpParams((prev) => ({
                ...prev,
                [o.id]: { ...(prev[o.id] || {}), [pName]: pVal },
              }));
              const buildOpParams = () => {
                const out = {};
                for (const sp of specs) {
                  const raw = curMap[sp.name] !== undefined
                    ? curMap[sp.name]
                    : (sp.default !== undefined ? String(sp.default) : "");
                  if (raw === "" || raw == null) continue;
                  out[sp.name] = sp.type === "int" ? Number(raw) : raw;
                }
                return out;
              };
              return html`<article class="card" key=${o.id}>
                <h3>${o.name}</h3>
                <div class="muted mono">${o.id}</div>
                <div class="row">
                  ${o.source === "user" ? html`<span class="badge">user</span>` : null}
                  ${o.applicable === false ? html`<span class="badge danger">не привязана</span>` : null}
                  ${o.flags?.state_changing ? html`<span class="badge warn">state</span>` : html`<span class="badge">read</span>`}
                  ${o.flags?.escalatable ? html`<span class="badge">sudo opt-in</span>` : null}
                  ${o.flags?.streaming ? html`<span class="badge">stream</span>` : null}
                  ${o.display ? html`<span class="badge ok">display</span>` : null}
                </div>
                ${specs.map((sp) => {
                  const val = curMap[sp.name] !== undefined
                    ? curMap[sp.name]
                    : (sp.default !== undefined ? String(sp.default) : "");
                  const isUnits = sp.source === "server.allowed_units";
                  return html`<div class="form-sub" key=${sp.name}>
                    <label style="text-transform:none">
                      <span class="mono">${sp.name}</span>
                      ${sp.required ? html`<span class="err"> *</span>` : null}
                    </label>
                    ${sp.type === "int"
                      ? html`<input type="number" min=${sp.min} max=${sp.max} value=${val}
                                onInput=${(e) => setOpField(sp.name, e.target.value)} />`
                      : isUnits
                      ? html`<input list="allowed-units-datalist" placeholder="unit (начните вводить)" value=${val}
                                onInput=${(e) => setOpField(sp.name, e.target.value)} />`
                      : html`<input type=${sp.sensitive ? "password" : "text"}
                                placeholder=${sp.name}
                                value=${val}
                                onInput=${(e) => setOpField(sp.name, e.target.value)} />`}
                  </div>`;
                })}
                ${o.flags?.escalatable
                  ? html`<label class="check"><input type="checkbox" checked=${useSudo} onChange=${(e) => setUseSudo(e.target.checked)} /> Использовать sudo (явно)</label>`
                  : null}
                <button class="btn btn-primary"
                        disabled=${o.applicable === false}
                        title=${o.applicable === false ? "Операция не привязана к этому серверу" : ""}
                        onClick=${() => doPlan(o.id, buildOpParams(), o.flags?.escalatable)}>План</button>
              </article>`;
            })}
            ${ops.filter((o) => !o.valid).map((o) => html`<article class="card" key=${o.id}><span class="badge danger">невалидна</span><div>${o.name}</div><div class="err">${o.error}</div></article>`)}
          </div>`}
        </div>`;
        })()
      : null}
    ${tab === "graph"
      ? html`<div class="stack" style="height: calc(100vh - 220px); min-height: 480px;">
          <${AutomationGraphView} initialServerId=${Number(id)} isServerTab=${true} />
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
            <h3>Сбор и хранение метрик</h3>
            <p class="muted small">
              Сейчас действует: сбор каждые <b>${srv.effective_metrics_interval_sec ?? 30}с</b>
              · сырые (raw): <b>${srv.effective_retention_raw_days === 0 ? "вечно" : ((srv.effective_retention_raw_days ?? 3) + " дн")}</b>
              · агрегаты (5m): <b>${srv.effective_retention_agg_days === 0 ? "вечно" : ((srv.effective_retention_agg_days ?? 30) + " дн")}</b>.
              Пустое значение = использовать глобальные настройки.
            </p>

            <div class="form-sub">
              <label>Интервал сбора (сек, от 5 до 300)</label>
              <div class="preset-pills">
                ${[
                  ["", "Глобально"],
                  ["5", "5с"],
                  ["10", "10с"],
                  ["15", "15с"],
                  ["30", "30с"],
                  ["60", "60с"],
                ].map(([val, lbl]) => html`<button type="button" key=${"iv-" + val}
                    class=${"preset-pill" + (metricsCfg.interval === val ? " on" : "")}
                    onClick=${() => setMetricsCfg({ ...metricsCfg, interval: val })}>${lbl}</button>`)}
              </div>
              <input type="number" min="5" max="300" style="max-width:220px"
                     placeholder="глобально (по умолчанию 30с)"
                     value=${metricsCfg.interval}
                     onInput=${(e) => setMetricsCfg({ ...metricsCfg, interval: e.target.value })} />
              ${metricsCfg.interval !== "" && Number(metricsCfg.interval) > 0 && Number(metricsCfg.interval) < 15
                ? html`<div class="muted small" style="color:var(--warn)">
                    Частый сбор (&lt; 15с) увеличивает нагрузку на SSH и объём БД — рекомендуется задать срок хранения ниже.
                  </div>`
                : null}
            </div>

            <div class="form-sub">
              <label>Хранение сырых метрик (дней, 0 = вечно)</label>
              <div class="preset-pills">
                ${[
                  ["", "Глобально"],
                  ["1", "1 день"],
                  ["3", "3 дня"],
                  ["7", "7 дней"],
                  ["30", "30 дней"],
                  ["0", "Вечно"],
                ].map(([val, lbl]) => html`<button type="button" key=${"raw-" + val}
                    class=${"preset-pill" + (metricsCfg.raw_days === val ? " on" : "")}
                    onClick=${() => setMetricsCfg({ ...metricsCfg, raw_days: val })}>${lbl}</button>`)}
              </div>
              <input type="number" min="0" max="3650" style="max-width:220px"
                     placeholder="глобально"
                     value=${metricsCfg.raw_days}
                     onInput=${(e) => setMetricsCfg({ ...metricsCfg, raw_days: e.target.value })} />
            </div>

            <div class="form-sub">
              <label>Хранение агрегатов 5m (дней, 0 = вечно)</label>
              <div class="preset-pills">
                ${[
                  ["", "Глобально"],
                  ["7", "7 дней"],
                  ["30", "30 дней"],
                  ["90", "90 дней"],
                  ["365", "1 год"],
                  ["0", "Вечно"],
                ].map(([val, lbl]) => html`<button type="button" key=${"agg-" + val}
                    class=${"preset-pill" + (metricsCfg.agg_days === val ? " on" : "")}
                    onClick=${() => setMetricsCfg({ ...metricsCfg, agg_days: val })}>${lbl}</button>`)}
              </div>
              <input type="number" min="0" max="3650" style="max-width:220px"
                     placeholder="глобально"
                     value=${metricsCfg.agg_days}
                     onInput=${(e) => setMetricsCfg({ ...metricsCfg, agg_days: e.target.value })} />
            </div>

            <div class="row">
              <button type="button" class="btn btn-sm btn-primary"
                      disabled=${metricsCfgBusy}
                      onClick=${doSaveMetricsCfg}>
                ${metricsCfgBusy ? "Сохранение…" : "Сохранить настройки метрик"}
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
              ? html`<${SshKeyPathField}
                      value=${authDraft.key_path}
                      onChange=${(v) => setAuthDraft({ ...authDraft, key_path: v })} />
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
          <${OperationResultView}
            op=${ops.find((o) => o.id === exec._oid) || null}
            steps=${exec.steps || []} />
        </${Modal}>`
      : null}
    ${streamExec
      ? html`<${StreamExecModal}
            job=${streamExec}
            op=${streamExec.op}
            onClose=${() => setStreamExec(null)} />`
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
      ? html`<${SshKeyPathField} value=${form.key_path || ""} onChange=${(v) => set("key_path", v)} />
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
      ? html`<div class=${"card audit-status-card " + (!integ.ok ? "danger" : (integ.code === "AUDIT_DISABLED" ? "warn" : "ok"))}>
          <span>${integ.message}</span>
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
function expandMsgContent(m) {
  let c = (m.content || "").trim();
  if (m.attachment) {
    c = "[вложение: " + m.attachment.name + "]\n\n"
      + m.attachment.content
      + (c ? "\n\n" + c : "");
  }
  return c;
}

function buildContextHistory(msgs, modeLabel, contextCfg, reserveChars = 0) {
  const cfg = contextCfg || { max_messages: 20, max_chars: 32000, cross_mode: true };
  const cross = cfg.cross_mode !== false;
  const maxMsgs = Number(cfg.max_messages) > 0 ? Number(cfg.max_messages) : Infinity;
  const maxChars = Number(cfg.max_chars) > 0 ? Number(cfg.max_chars) : Infinity;
  const budget = maxChars === Infinity ? Infinity : Math.max(500, maxChars - reserveChars);

  const filtered = msgs
    .filter((m) => {
      if (!m || m.streaming || m.blocked) return false;
      if (m.role !== "user" && m.role !== "assistant") return false;
      if (!m.content && !m.attachment) return false;
      if (!cross) {
        if (modeLabel === "chat") return !m._mode || m._mode === "chat";
        return m._mode === modeLabel;
      }
      return true;
    })
    .map((m) => ({ role: m.role, content: expandMsgContent(m) }))
    .filter((m) => m.content.trim().length > 0);

  const selected = [];
  let totalChars = 0;
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (selected.length >= maxMsgs) break;
    const item = filtered[i];
    const len = item.content.length;
    if (totalChars + len > budget) {
      if (selected.length === 0 && budget !== Infinity) {
        selected.unshift({ role: item.role, content: item.content.slice(-budget) });
      }
      break;
    }
    selected.unshift(item);
    totalChars += len;
  }
  return selected;
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
  errorNotification, setErrorNotification,
  onMsgContextMenu,
  justClosedCtxRef,
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

  return html`<div class="modal-back llm-modal-back"
      onClick=${(e) => {
        if (e.target !== e.currentTarget) return;
        if (justClosedCtxRef && justClosedCtxRef.current) return;
        onClose();
      }}>
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
        ${errorNotification
          ? html`<div class="llm-modal-error-banner">
              <span class="llm-error-icon">⚠</span>
              <div class="llm-error-text grow">
                <b>${errorNotification.code || "Ошибка"}:</b> ${errorNotification.message}
              </div>
              <div class="llm-error-actions">
                ${errorNotification.onRetry
                  ? html`<button type="button" class="btn btn-sm btn-ghost llm-error-retry"
                                 onClick=${errorNotification.onRetry}>Повторить</button>`
                  : null}
                <button type="button" class="llm-error-close"
                        title="Закрыть"
                        onClick=${() => setErrorNotification && setErrorNotification(null)}>×</button>
              </div>
            </div>`
          : null}

        ${!expanded
          ? html`<div class="llm-chat" ref=${chatBoxRef}>
              ${messages.length === 0
                ? html`<div class="llm-chat-empty">
                    Напишите сообщение, чтобы начать.
                    <br/><span class="mono">/help</span> — список команд
                  </div>`
                : (() => {
                    const lastUserIdx = messages.map((x) => x.role).lastIndexOf("user");
                    const lastAssistantIdx = messages.map((x) => x.role).lastIndexOf("assistant");
                    return messages.map((m, i) => {
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
                    return html`<div key=${i} class=${"llm-msg-block " + m.role}
                        onContextMenu=${(e) => onMsgContextMenu && onMsgContextMenu(e, m, i, lastUserIdx, lastAssistantIdx)}>
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
                        ${m.blocked ? "🚫 " : ""}${(m.content || "").replace(/\n+$/, "") || (m.streaming ? (m.retryNotice ? html`<span class="llm-retry-indicator">${m.retryNotice}</span>` : (m.waitingText || "")) : (m.attachment ? "" : "…"))}
                      </div>
                      <div class=${"llm-reveal" + (actions.length ? " shown" : "")}>
                        <div class="llm-reveal-inner">
                          ${actions.length
                            ? html`<div class="llm-msg-actions">${actions}</div>`
                            : null}
                        </div>
                      </div>
                    </div>`;
                  });
                })()}
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
  const [errorNotification, setErrorNotification] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [contextCfg, setContextCfg] = useState({ max_messages: 20, max_chars: 32000, cross_mode: true });
  const abortRef = useRef(null);
  const chatBoxRef = useRef(null);
  const inputRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const rafRef = useRef(null);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const justClosedCtxRef = useRef(false);
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
    if (!contextMenu) return undefined;
    function onDoc(e) {
      if (!e.target.closest(".llm-context-menu")) {
        setContextMenu(null);
        justClosedCtxRef.current = true;
        setTimeout(() => { justClosedCtxRef.current = false; }, 100);
      }
    }
    function onKey(e) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

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
    window.addEventListener("melecho:refresh-status", onRefresh);
    return () => {
      window.removeEventListener("melecho:refresh-llm-profiles", onRefresh);
      window.removeEventListener("melecho:refresh-status", onRefresh);
    };
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
      setContextCfg({
        max_messages: s.llm_context_max_messages ?? 20,
        max_chars: s.llm_context_max_chars ?? 32000,
        cross_mode: s.llm_context_cross_mode !== false,
      });
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
  function closeWindow() {
    setState("hidden");
    setErrorNotification(null);
    persist("hidden", currentPos, size);
  }

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
  async function suggestStream(modeLabel, endpoint, placeholderText, body, applyFinal, userContentOverride, skipUserMsg = false) {
    if (streaming) return;
    setErrorNotification(null);
    resetSuggestQueue();
    resetStreamQueue();     // на всякий случай: не должно быть активного чата
    const userContent = userContentOverride || ("/" + modeLabel + " " + (body.description || ""));
    const userMsg = { role: "user", content: userContent, _mode: modeLabel };
    const placeholder = { role: "assistant", content: "", waitingText: placeholderText, streaming: true, _mode: modeLabel };
    setMessages((prev) => skipUserMsg ? [...prev, placeholder] : [...prev, userMsg, placeholder]);
    if (!skipUserMsg) setInput("");
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
            if (obj.type === "retry") {
              const attemptStr = `${obj.attempt}/${obj.max_attempts}`;
              replaceLastAssistant((last) => ({
                ...last,
                retryNotice: `Повтор запроса (${attemptStr})…`,
              }));
            } else if (obj.type === "chunk") {
              replaceLastAssistant((last) => ({
                ...last,
                retryNotice: null,
              }));
            }
            if (obj.type === "error") {
              streamErr = { code: obj.code, message: obj.message };
              break;
            }
            handleSuggestEvent(obj);
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
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            return prev.slice(0, -1);
          }
          return prev;
        });
        if (stateRef.current !== "hidden" || chatOpenRef.current) {
          setErrorNotification({
            code,
            message: msg,
            onRetry: () => {
              setErrorNotification(null);
              suggestStream(modeLabel, endpoint, placeholderText, body, applyFinal, userContentOverride, true);
            },
          });
        }
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
      suggestApplyFinalRef.current = null;
    }
  }

  async function sendAlertCommand(description, skipUserMsg = false, historyMsgs = null) {
    if (!description) return;
    const history = buildContextHistory(historyMsgs || messages, "alert", contextCfg, description.length);
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
      undefined,
      skipUserMsg,
    );
  }

  async function sendReactionCommand(description, skipUserMsg = false, historyMsgs = null) {
    if (!description) return;
    const history = buildContextHistory(historyMsgs || messages, "reaction", contextCfg, description.length);
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
      undefined,
      skipUserMsg,
    );
  }

  // Одноразовое объяснение конкретного алерта. НЕ sticky, не меняет режим.
  // Пользователь пишет "/explain 42 почему упало?" — открывается контекст
  // алерта, LLM отвечает текстом (без JSON/YAML). Под ответом появляется
  // кнопка «Открыть алерт #N» для перехода к модалке.
  async function sendExplainCommand(alertId, question, attach, skipUserMsg = false) {
    if (!alertId || streaming) return;
    resetStreamQueue();
    const q = (question || "").trim();
    // Два источника:
    //   - явный /explain N вопрос → userMsg с префиксом, без вложения
    //   - экспорт алерта (↗) + текст → userMsg обычный, attachment виден
    // Обработка одинаковая: POST /llm/explain-alert.
    const userMsg = attach
      ? { role: "user", content: q, attachment: attach, _mode: "chat" }
      : { role: "user", content: "/explain " + alertId + (q ? " " + q : ""), _mode: "chat" };
    const placeholder = { role: "assistant", content: "", waitingText: "Готовлю объяснение…", streaming: true, _mode: "chat" };
    setMessages((prev) => skipUserMsg ? [...prev, placeholder] : [...prev, userMsg, placeholder]);
    if (!skipUserMsg) {
      setInput("");
      setAttachment(null);   // attachment израсходован
    }
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
  async function sendExplainRuleCommand(ruleId, question, skipUserMsg = false) {
    if (!ruleId || streaming) return;
    resetStreamQueue();
    const q = (question || "").trim();
    const userMsg = { role: "user", content: "/explain-rule " + ruleId + (q ? " " + q : ""), _mode: "chat" };
    const placeholder = { role: "assistant", content: "", waitingText: "Готовлю объяснение…", streaming: true, _mode: "chat" };
    setMessages((prev) => skipUserMsg ? [...prev, placeholder] : [...prev, userMsg, placeholder]);
    if (!skipUserMsg) setInput("");
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
  async function sendEditRuleCommand(ruleId, description, skipUserMsg = false, historyMsgs = null) {
    if (!ruleId) return;
    const desc = (description || "").trim();
    if (!desc) {
      setMessages((prev) => [...prev,
        { role: "user", content: "/edit-rule " + ruleId },
        { role: "assistant",
          content: "Укажите описание правки: /edit-rule <id> <что изменить>" },
      ]);
      if (!skipUserMsg) setInput("");
      return;
    }
    const history = buildContextHistory(historyMsgs || messages, "edit-rule", contextCfg, desc.length);
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
      skipUserMsg,
    );
  }

  async function sendOperationCommand(description, skipUserMsg = false, historyMsgs = null) {
    if (!description) return;
    const history = buildContextHistory(historyMsgs || messages, "operation", contextCfg, description.length);
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
      undefined,
      skipUserMsg,
    );
  }

  function sendMessage() {
    const text = input.trim();
    const attach = attachment;
    if ((!text && !attach) || streaming) return;
    return dispatchPrompt(text, attach, chatMode, false);
  }

  function editLastUserMessage(idx) {
    if (streaming) return;
    const targetIdx = idx != null ? idx : messages.map((m) => m.role).lastIndexOf("user");
    if (targetIdx === -1) return;
    const userMsg = messages[targetIdx];
    if (!userMsg) return;
    setInput(userMsg.content || "");
    setAttachment(userMsg.attachment || null);
    if (userMsg._mode && LLM_CHAT_MODES.some((m) => m.value === userMsg._mode)) {
      setChatMode(userMsg._mode);
    }
    setMessages((prev) => prev.slice(0, targetIdx));
    setErrorNotification(null);
    setTimeout(() => {
      try {
        if (chatOpen) {
          const modalTa = document.querySelector(".llm-chat-modal-input-area textarea");
          if (modalTa) { modalTa.focus(); return; }
        }
        inputRef.current && inputRef.current.focus();
      } catch {}
    }, 50);
  }

  function regenerateLastResponse() {
    if (streaming) return;
    const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistantIdx === -1) return;
    let prevUserIdx = -1;
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        prevUserIdx = i;
        break;
      }
    }
    if (prevUserIdx === -1) return;
    const userMsg = messages[prevUserIdx];
    const historySlice = messages.slice(0, prevUserIdx);
    setMessages((prev) => prev.slice(0, prevUserIdx + 1));
    setErrorNotification(null);
    dispatchPrompt(
      userMsg.content || "",
      userMsg.attachment || null,
      userMsg._mode || "chat",
      true,
      historySlice,
    );
  }

  async function dispatchPrompt(text, attach, mode, skipUserMsg = false, historyMsgs = null) {
    // Явный /operation <описание> — переключает режим и отправляет.
    // /operation без текста — только переключение, поле очищается,
    // пользователь пишет описание следующим сообщением.
    // /help — локальная справка, без LLM.
    if (text === "/help") {
      setMessages((prev) => skipUserMsg
        ? [...prev, { role: "assistant", content: LLM_HELP_TEXT }]
        : [
            ...prev,
            { role: "user", content: "/help" },
            { role: "assistant", content: LLM_HELP_TEXT },
          ]);
      if (!skipUserMsg) setInput("");
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
        if (!skipUserMsg) setInput("");
        return;
      }
      const rid = Number(m[1]);
      const q = (m[2] || "").trim();
      return sendExplainRuleCommand(rid, q, skipUserMsg);
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
        if (!skipUserMsg) setInput("");
        return;
      }
      const rid = Number(m[1]);
      const desc = (m[2] || "").trim();
      return sendEditRuleCommand(rid, desc, skipUserMsg, historyMsgs);
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
        if (!skipUserMsg) setInput("");
        return;
      }
      const aid = Number(m[1]);
      const q = (m[2] || "").trim();
      return sendExplainCommand(aid, q, undefined, skipUserMsg);
    }

    // Если во вложении есть alert_id — работаем как /explain: тот же
    // endpoint, тот же промпт, тот же формат ответа. Это унифицирует
    // «/explain 1 вопрос» и «экспорт алерта + вопрос» — поведение
    // одинаковое, отличается только способ передать контекст.
    if (attach && typeof attach.alert_id === "number") {
      return sendExplainCommand(attach.alert_id, text, attach, skipUserMsg);
    }

    // Явные префиксы режимов: /operation, /alert, /reaction.
    const MODE_PREFIXES = ["operation", "alert", "reaction"];
    for (const m of MODE_PREFIXES) {
      const pfx = "/" + m;
      if (text === pfx || text.startsWith(pfx + " ")) {
        const desc = text.slice(pfx.length).trim();
        if (!skipUserMsg) setChatMode(m);
        if (!desc) {
          if (!skipUserMsg) setInput("");
          return;
        }
        if (m === "operation") return sendOperationCommand(desc, skipUserMsg, historyMsgs);
        if (m === "alert")     return sendAlertCommand(desc, skipUserMsg, historyMsgs);
        if (m === "reaction")  return sendReactionCommand(desc, skipUserMsg, historyMsgs);
      }
    }
    // sticky-режим: каждое сообщение в operation идёт в suggest.
    // Пустое поле — не отправляем. Вложение игнорируется: suggest
    // принимает только текст-описание.
    if (mode !== "chat") {
      if (!text) return;
      if (mode === "operation") return sendOperationCommand(text, skipUserMsg, historyMsgs);
      if (mode === "alert")     return sendAlertCommand(text, skipUserMsg, historyMsgs);
      if (mode === "reaction")  return sendReactionCommand(text, skipUserMsg, historyMsgs);
    }
    // Отправляем, если есть хоть что-то: текст или вложение.
    if ((!text && !attach) || streaming) return;

    // Для LLM собираем плоский content: если у сообщения было вложение —
    // разворачиваем его в маркированный блок. Так LLM видит содержимое
    // независимо от того, читается история из LS или с текущего состояния.
    const currentContent = expandMsgContent({ content: text, attachment: attach });
    const history = buildContextHistory(historyMsgs || messages, "chat", contextCfg, currentContent.length);

    const outgoing = [
      ...history,
      { role: "user", content: currentContent },
    ];

    return sendChatStream(outgoing, skipUserMsg, text, attach);
  }

  async function sendChatStream(outgoingMessages, skipUserMsg, userText, userAttach) {
    setErrorNotification(null);
    const userMsg = { role: "user", content: userText, _mode: "chat" };
    if (userAttach) userMsg.attachment = userAttach;
    const placeholder = { role: "assistant", content: '', streaming: true, _mode: "chat" };
    resetStreamQueue();
    setMessages((prev) => skipUserMsg ? [...prev, placeholder] : [...prev, userMsg, placeholder]);
    if (!skipUserMsg) {
      setInput('');
      setAttachment(null);
    }
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
        body: JSON.stringify({ messages: outgoingMessages, max_tokens: 4000 }),
        signal: ctrl.signal,
      });

      if (!r.ok) {
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
          if (obj.type === "retry") {
            const attemptStr = `${obj.attempt}/${obj.max_attempts}`;
            replaceLastAssistant((last) => ({
              ...last,
              retryNotice: `Повтор запроса (${attemptStr})…`,
            }));
          } else if (obj.type === "chunk" && typeof obj.text === "string") {
            replaceLastAssistant((last) => ({
              ...last,
              retryNotice: null,
            }));
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
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            return prev.slice(0, -1);
          }
          return prev;
        });
        if (stateRef.current !== "hidden" || chatOpenRef.current) {
          setErrorNotification({
            code,
            message: msg,
            onRetry: () => {
              setErrorNotification(null);
              sendChatStream(outgoingMessages, true, userText, userAttach);
            },
          });
        }
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

  function handleMsgContextMenu(e, m, i, lastUserIdx, lastAssistantIdx) {
    if (streaming) return;
    if (m.role === "user" && i === lastUserIdx) {
      e.preventDefault();
      setContextMenu({
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 45),
        label: "✎ Редактировать запрос",
        action: () => editLastUserMessage(i),
      });
    } else if (m.role === "assistant" && i === lastAssistantIdx) {
      e.preventDefault();
      setContextMenu({
        x: Math.min(e.clientX, window.innerWidth - 210),
        y: Math.min(e.clientY, window.innerHeight - 45),
        label: "⟳ Перегенерировать ответ",
        action: () => regenerateLastResponse(),
      });
    }
  }

  const cls = "llm-window " + (state === "collapsed" ? "collapsed" : "") + (dragging ? " dragging" : "");
  const style = `left: ${currentPos.x}px; top: ${currentPos.y}px; width: ${size.w}px;` +
    (state === "open" ? ` height: ${size.h}px;` : "");
  const errBannerStyle = currentPos.y >= 72
    ? `left: ${currentPos.x}px; width: ${size.w}px; bottom: calc(100vh - ${currentPos.y}px + 8px);`
    : `left: ${currentPos.x}px; width: ${size.w}px; top: ${Math.min(currentPos.y + size.h + 8, window.innerHeight - 60)}px;`;

  return html`
    ${state === "hidden"
      ? html`<button class="llm-window-fab" title="Открыть окно LLM" onClick=${openWindow}>LLM</button>`
      : html`
          ${errorNotification && state === "open" && !chatOpen
            ? html`<div class="llm-window-error-banner" style=${errBannerStyle}>
                <span class="llm-error-icon">⚠</span>
                <div class="llm-error-text grow">
                  <b>${errorNotification.code || "Ошибка"}:</b> ${errorNotification.message}
                </div>
                <div class="llm-error-actions">
                  ${errorNotification.onRetry
                    ? html`<button type="button" class="btn btn-sm btn-ghost llm-error-retry"
                                   onClick=${errorNotification.onRetry}>Повторить</button>`
                    : null}
                  <button type="button" class="llm-error-close"
                          title="Закрыть"
                          onClick=${() => setErrorNotification(null)}>×</button>
                </div>
              </div>`
            : null}
          <div class=${cls} style=${style}>
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
                      : (() => {
                          const lastUserIdx = messages.map((x) => x.role).lastIndexOf("user");
                          const lastAssistantIdx = messages.map((x) => x.role).lastIndexOf("assistant");
                          return messages.map((m, i) => {
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
                          return html`<div key=${i} class=${"llm-msg-block " + m.role}
                              onContextMenu=${(e) => handleMsgContextMenu(e, m, i, lastUserIdx, lastAssistantIdx)}>
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
                              ${m.blocked ? "🚫 " : ""}${(m.content || "").replace(/\n+$/, "") || (m.streaming ? (m.retryNotice ? html`<span class="llm-retry-indicator">${m.retryNotice}</span>` : (m.waitingText || "")) : (m.attachment ? "" : "…"))}
                            </div>
                            <div class=${"llm-reveal" + (actions.length ? " shown" : "")}>
                              <div class="llm-reveal-inner">
                                ${actions.length
                                  ? html`<div class="llm-msg-actions">${actions}</div>`
                                  : null}
                              </div>
                            </div>
                          </div>`;
                        });
                      })()}
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
          </div>
        `}
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
            onClose=${() => setChatOpen(false)}
            errorNotification=${errorNotification}
            setErrorNotification=${setErrorNotification}
            onMsgContextMenu=${handleMsgContextMenu}
            justClosedCtxRef=${justClosedCtxRef} />`
      : null}
    ${contextMenu
      ? html`<div class="llm-context-menu"
                  style=${`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
                  onContextMenu=${(e) => e.preventDefault()}>
          <button type="button" class="llm-context-menu-item" onClick=${() => {
            const act = contextMenu.action;
            setContextMenu(null);
            act();
          }}>
            ${contextMenu.label}
          </button>
        </div>`
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
  `;
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
      Глобальный срок хранения (для метрик может быть переопределён
      в настройках каждого сервера, в т. ч. на «вечно»). Активные алерты и
      незавершённые реакции не удаляются никогда, журнал аудита (HMAC-chain,
      S2) — вечный.
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
  const [opMeta, setOpMeta] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const rec = await api("/api/v1/reactions/" + rid);
      setR(rec);
      if (rec && rec.operation_id) {
        api("/api/v1/operations").then((res) => {
          const found = (res.items || []).find((o) => o.id === rec.operation_id);
          setOpMeta(found || null);
        }).catch(() => {});
      }
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
    <div>
      <div class="form-section-title" style="margin-bottom:6px">Вывод</div>
      <${OperationResultView}
        op=${opMeta}
        stdout=${r.stdout_trunc || ""}
        stderr=${r.stderr_trunc || ""}
        exitCode=${r.exit_code} />
    </div>
  </${Modal}>`;
}

// Единый редактор правила реакции. Используется:
//   - ReactionsView (Правка / + Новое) — initial = реакция из БД или пустая
//   - AppShell при создании из LLM — initial = конвертированный valid_rule
//
// Сам загружает servers/ops/alert_rules при монтировании: списки нужны
// для селектов. Раньше это жило в ReactionsView, теперь — здесь, чтобы
// компонент можно было вызвать откуда угодно.

function fmtSecHint(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 60) return `${n} с`;
  const m = n / 60;
  return Number.isInteger(m) ? `${m} мин` : `${m.toFixed(1)} мин`;
}

// Автоматическая форма параметров операции по op.params из каталога.
// Держит синхронизацию со строкой JSON paramsStr; при невалидном JSON
// открывает сырой редактор, чтобы ничего не потерялось.
function OperationParamsFields({ op, paramsStr, onChangeStr, servers }) {
  const specs = (op && Array.isArray(op.params)) ? op.params : [];
  let obj = {};
  let jsonErr = false;
  try {
    const parsed = JSON.parse(paramsStr || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed;
    else jsonErr = true;
  } catch {
    jsonErr = true;
  }

  const allAllowedUnits = useMemo(() => {
    const u = new Set();
    for (const srv of (servers || [])) {
      for (const name of (srv.allowed_units || [])) u.add(name);
    }
    return [...u].sort();
  }, [servers]);

  function setField(key, rawVal, type) {
    const next = { ...obj };
    if (rawVal === "" || rawVal == null) {
      delete next[key];
    } else if (type === "int") {
      const n = Number(rawVal);
      next[key] = Number.isFinite(n) ? n : rawVal;
    } else {
      next[key] = rawVal;
    }
    onChangeStr(JSON.stringify(next, null, 2));
  }

  if (jsonErr) {
    return html`<div class="form-sub">
      <label>Параметры операции (JSON)</label>
      <div class="err small">JSON содержит синтаксическую ошибку — исправьте ниже:</div>
      <textarea class="mono llm-rule-cond" rows="3" value=${paramsStr}
                onInput=${(e) => onChangeStr(e.target.value)}></textarea>
    </div>`;
  }

  return html`<div class="form-sub">
    <label>Параметры операции</label>
    ${specs.length === 0
      ? html`<div class="muted small">У выбранной операции параметров нет.</div>`
      : html`<div class="stack" style="gap:8px">
          ${specs.map((sp) => {
            const val = obj[sp.name] !== undefined
              ? String(obj[sp.name])
              : (sp.default !== undefined ? String(sp.default) : "");
            const isUnits = sp.source === "server.allowed_units";
            const dlId = "op_units_" + sp.name;
            const hints = [];
            if (sp.required) hints.push("обязательный");
            if (sp.type) hints.push(sp.type);
            if (sp.min != null || sp.max != null) hints.push(`${sp.min ?? ""}..${sp.max ?? ""}`);
            if (sp.default != null) hints.push(`по умолч.: ${sp.default}`);
            return html`<div class="form-sub" key=${sp.name}>
              <label style="text-transform:none">
                <span class="mono">${sp.name}</span>
                ${sp.required ? html`<span class="err"> *</span>` : null}
                ${hints.length ? html`<span class="muted small"> · ${hints.join(", ")}</span>` : null}
              </label>
              ${sp.type === "int"
                ? html`<input type="number" min=${sp.min} max=${sp.max} value=${val}
                          onInput=${(e) => setField(sp.name, e.target.value, "int")} />`
                : isUnits
                ? html`<input list=${dlId} placeholder="например nginx.service" value=${val}
                          onInput=${(e) => setField(sp.name, e.target.value, "str")} />
                      <datalist id=${dlId}>
                        ${allAllowedUnits.map((u) => html`<option value=${u} key=${u} />`)}
                      </datalist>`
                : html`<input type=${sp.sensitive ? "password" : "text"}
                          placeholder=${sp.pattern ? `шаблон: ${sp.pattern}` : ""}
                          value=${val}
                          onInput=${(e) => setField(sp.name, e.target.value, "str")} />`}
            </div>`;
          })}
        </div>`}
    <details>
      <summary class="muted small">Параметры как JSON</summary>
      <textarea class="mono llm-rule-cond" rows="3" style="margin-top:6px"
                value=${paramsStr}
                onInput=${(e) => onChangeStr(e.target.value)}></textarea>
    </details>
  </div>`;
}

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

  const filteredAlertRules = useMemo(() => {
    if (!editing || editing.match_servers_all) return rules;
    const sids = new Set(editing.match_server_ids || []);
    if (sids.size === 0) return rules;
    return rules.filter((r) => r.server_id == null || sids.has(r.server_id));
  }, [rules, editing]);

  const selectedOp = useMemo(
    () => ops.find((o) => o.id === (editing && editing.operation_id)) || null,
    [ops, editing && editing.operation_id],
  );
  const opForcesConfirm = !!(
    selectedOp && selectedOp.flags && (selectedOp.flags.dangerous || selectedOp.flags.state_changing)
  );

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
        action_policy: opForcesConfirm ? "confirm" : editing.action_policy,
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
  const sudoOptions = [
    { value: "never", label: "без sudo", hint: "— команда не требует root-прав" },
    { value: "auto", label: "автосудо", hint: "— использовать пароль из Настройки → Автосудо" },
  ];
  if (editing.sudo_mode === "confirm") {
    sudoOptions.push({ value: "confirm", label: "confirm (как автосудо)", hint: "— использует пароль из Автосудо" });
  }

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
    <input placeholder="например: Перезапуск nginx при критическом сбое"
           value=${editing.name}
           onInput=${(e) => setEditing({ ...editing, name: e.target.value })} />

    <div class="form-section">
      <div class="form-section-title">
        Когда срабатывает (условие И)
        <${InfoHint} text="Реакция запускается на алерты, подходящие под ВСЕ заполненные фильтры одновременно. Пустой фильтр означает «без ограничения». Хотя бы один фильтр обязателен." />
      </div>
      <div class="muted small">
        Должны совпасть все указанные фильтры (пустое поле = любое значение).
      </div>

      <div class="form-sub">
        <label>
          Конкретные правила алертов
          <${InfoHint} text="Выберите правила, на срабатывание которых должна отвечать реакция. Пусто = любое правило." />
        </label>
        <${MultiSelect}
          options=${filteredAlertRules.map((ar) => ({
            value: ar.id,
            label: (ar.server_id == null ? "🌐 " : "🖥 ") + ar.name,
          }))}
          selected=${editing.match_rule_ids}
          onChange=${(ids) => setEditing({ ...editing, match_rule_ids: ids })}
          placeholder="все правила алертов"
          emptyText="нет подходящих правил" />
      </div>

      <div class="form-sub">
        <label>Важность (Severity) <${InfoHint} text="Критичность алерта. Пусто = любая." /></label>
        <${MultiSelect}
          options=${[
            { value: "critical", label: "critical" },
            { value: "warning", label: "warning" },
            { value: "info", label: "info" },
          ]}
          selected=${editing.match_severities}
          onChange=${(s) => setEditing({ ...editing, match_severities: s })}
          placeholder="любая важность" />
      </div>

      <div class="form-sub">
        <label>Типы условий <${InfoHint} text="На какие типы условий алерта реагировать. Пусто = на любые." /></label>
        <${MultiSelect}
          options=${Object.entries(CONDITION_KIND_LABELS).map(([k, label]) => ({
            value: k, label,
          }))}
          selected=${editing.match_condition_kinds}
          onChange=${(s) => setEditing({ ...editing, match_condition_kinds: s })}
          placeholder="любой тип условия" />
      </div>

      <div class="form-sub">
        <label>Серверы <${InfoHint} text="Реакция сработает только для алертов с выбранных серверов." /></label>
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
      <div class="form-section-title">Что выполнять (Действие)</div>
      <div class="form-sub">
        <label>Операция</label>
        <select value=${editing.operation_id}
                onChange=${(e) => setEditing({ ...editing, operation_id: e.target.value, params: "{}" })}>
          ${ops.map((o) => html`<option value=${o.id}>${o.name} (${o.id})</option>`)}
        </select>
      </div>
      <${OperationParamsFields}
        op=${selectedOp}
        paramsStr=${editing.params}
        onChangeStr=${(v) => setEditing({ ...editing, params: v })}
        servers=${servers} />
      <div class="form-sub">
        <label>На каком сервере выполнять</label>
        <select value=${editing.run_on_server}
                onChange=${(e) => setEditing({ ...editing, run_on_server: e.target.value })}>
          <option value="same_as_alert">Тот же сервер, где возник алерт</option>
          ${servers.map((s) => html`<option value=${String(s.id)}>${s.name} (${s.llm_alias})</option>`)}
        </select>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Права и подтверждение</div>
      <div class="form-sub">
        <label>Права sudo</label>
        <${Radio}
          value=${editing.sudo_mode}
          onChange=${(v) => setEditing({ ...editing, sudo_mode: v })}
          options=${sudoOptions} />
      </div>
      <div class="form-sub">
        <label>Политика запуска</label>
        ${opForcesConfirm
          ? html`<div class="banner warn small">
              Выбранная операция меняет состояние или отмечена как опасная —
              запуск всегда требует вашего подтверждения (confirm) в очереди реакций.
            </div>`
          : html`<${Radio}
              value=${editing.action_policy}
              onChange=${(v) => setEditing({ ...editing, action_policy: v })}
              options=${[
                { value: "confirm", label: "confirm (с подтверждением)", hint: "— попадёт в очередь ожидания" },
                { value: "auto", label: "auto (автоматически)", hint: "— выполнится сразу без запроса" },
              ]} />`}
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Тайминги и ограничения</div>
      <div class="row">
        <div style="flex:1">
          <label>
            Пауза (Cooldown), сек
            <${InfoHint} text="Минимальная пауза между запусками этого правила на одном и том же сервере." />
          </label>
          <input type="number" min="0" max="86400" value=${editing.cooldown_sec}
                 onInput=${(e) => setEditing({ ...editing, cooldown_sec: Number(e.target.value) })} />
          <div class="muted small">${fmtSecHint(editing.cooldown_sec)}</div>
        </div>
        <div style="flex:1">
          <label>
            Попыток на алерт
            <${InfoHint} text="Максимум срабатываний этого правила на один и тот же активный алерт." />
          </label>
          <input type="number" min="1" max="20" value=${editing.max_attempts_per_alert}
                 onInput=${(e) => setEditing({ ...editing, max_attempts_per_alert: Number(e.target.value) })} />
        </div>
        <div style="flex:1">
          <label>
            Глубина цепочки
            <${InfoHint} text="Ограничивает вложенные цепочки реакций (защита от зацикливания; у обычных алертов depth = 0)." />
          </label>
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

const OP_CATEGORY_LABELS = {
  storage: "хранение",
  services: "сервисы",
  logs: "логи",
  packages: "пакеты",
  network: "сеть",
  other: "прочее",
};

function opCategoryLabel(cat) {
  const k = cat || "other";
  return OP_CATEGORY_LABELS[k] || k;
}

function renderLinksStatus(links, servers) {
  if (!links) return null;
  const ids = links.server_ids || [];
  if (links.is_unbound || (!links.is_global && ids.length === 0)) {
    return html`<span class="sev-warning" title="Привяжите серверы в правке, чтобы операцию можно было запускать">серверы: не привязана</span>`;
  }
  if (links.is_global) {
    return html`<span>серверы: все</span>`;
  }
  const names = ids.map((id) => {
    const srv = servers.find((x) => x.id === id);
    return srv ? srv.name : ("#" + id);
  });
  return html`<span>серверы: ${names.join(", ")}</span>`;
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
      timer = setTimeout(() => { fetchBatch(false); }, 1000);
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


function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v ?? ""));
}

function serializeDisplayBlock(disp) {
  if (!disp || !disp.type) return "";
  const lines = ["display:", `  type: ${disp.type}`];
  if (disp.title) lines.push(`  title: ${yamlScalar(disp.title)}`);
  if (disp.empty_text) lines.push(`  empty_text: ${yamlScalar(disp.empty_text)}`);
  if (disp.step != null) lines.push(`  step: ${Number(disp.step)}`);

  if (disp.type === "lines") {
    if (disp.include && disp.include.length) {
      lines.push("  include:");
      for (const p of disp.include) lines.push(`    - ${yamlScalar(p)}`);
    }
    if (disp.exclude && disp.exclude.length) {
      lines.push("  exclude:");
      for (const p of disp.exclude) lines.push(`    - ${yamlScalar(p)}`);
    }
    return lines.join("\n") + "\n";
  }

  lines.push(`  format: ${disp.format || (disp.type === "kv" ? "regex" : "json")}`);
  if (disp.type === "kv") {
    lines.push("  fields:");
    for (const f of (disp.fields || [])) {
      lines.push(`    - label: ${yamlScalar(f.label || "")}`);
      if ((disp.format || "regex") === "regex") {
        lines.push(`      regex: ${yamlScalar(f.regex || "")}`);
        if (f.group != null && f.group !== "") lines.push(`      group: ${Number(f.group)}`);
      } else {
        lines.push(`      key: ${yamlScalar(f.key || "")}`);
      }
      for (const opt of ["format", "ok_if", "warn_if", "danger_if"]) {
        if (f[opt]) lines.push(`      ${opt}: ${yamlScalar(f[opt])}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  if (disp.type === "table") {
    if ((disp.format || "json") === "regex") {
      lines.push(`  regex: ${yamlScalar(disp.regex || "")}`);
      if (disp.skip_lines) lines.push(`  skip_lines: ${Number(disp.skip_lines)}`);
    } else {
      if (disp.items_path) lines.push(`  items_path: ${yamlScalar(disp.items_path)}`);
      if (disp.children_key) lines.push(`  children_key: ${yamlScalar(disp.children_key)}`);
      if (disp.other_summary) lines.push(`  other_summary: ${yamlScalar(disp.other_summary)}`);
    }
    lines.push("  columns:");
    for (const c of (disp.columns || [])) {
      lines.push(`    - key: ${yamlScalar(c.key || "")}`);
      lines.push(`      label: ${yamlScalar(c.label || "")}`);
      if (c.format) lines.push(`      format: ${yamlScalar(c.format)}`);
      if (c.expr) lines.push(`      expr: ${yamlScalar(c.expr)}`);
      if (c.warn_gt != null && c.warn_gt !== "") lines.push(`      warn_gt: ${Number(c.warn_gt)}`);
      if (c.danger_gt != null && c.danger_gt !== "") lines.push(`      danger_gt: ${Number(c.danger_gt)}`);
    }
    return lines.join("\n") + "\n";
  }
  return "";
}

function replaceYamlFlagsSection(yamlText, flagsObj) {
  const lines = String(yamlText || "").split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^flags\s*:/.test(lines[i])) {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[j])) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  const keys = [
    "dangerous", "requires_confirmation", "idempotent",
    "plan_preview_supported", "reversible", "expect_disconnect",
    "escalatable", "state_changing", "streaming",
  ];
  const block = ["flags:"];
  for (const k of keys) {
    if (flagsObj[k] !== undefined) block.push(`  ${k}: ${Boolean(flagsObj[k])}`);
  }
  let nextLines;
  if (start !== -1) {
    nextLines = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  } else {
    const idxSteps = lines.findIndex((l) => /^steps\s*:/.test(l));
    if (idxSteps !== -1) {
      nextLines = [...lines.slice(0, idxSteps), ...block, ...lines.slice(idxSteps)];
    } else {
      nextLines = [...lines, ...block];
    }
  }
  return nextLines.join("\n").replace(/\n+$/, "") + "\n";
}

function replaceYamlDisplaySection(yamlText, disp) {
  const lines = String(yamlText || "").split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^display\s*:/.test(lines[i])) {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[j])) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  const block = disp ? serializeDisplayBlock(disp).trimEnd().split("\n") : [];
  let nextLines;
  if (start !== -1) {
    nextLines = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  } else if (block.length) {
    const trimmed = lines.slice();
    while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
    nextLines = [...trimmed, ...block];
  } else {
    nextLines = lines;
  }
  return nextLines.join("\n").replace(/\n+$/, "") + "\n";
}

function UserOpDisplayBuilder({ activeDisplay, onApplyDisplay }) {
  const [sampleOut, setSampleOut] = useState("");
  const isSections = activeDisplay && activeDisplay.type === "sections";
  const curType = activeDisplay ? activeDisplay.type : "none";

  function switchType(nextType) {
    if (nextType === "none") {
      onApplyDisplay(null);
      return;
    }
    if (nextType === "kv") {
      onApplyDisplay({
        type: "kv",
        format: "regex",
        fields: [{ label: "Resolver", regex: "^Resolver\\s*:\\s*(.+)$" }],
      });
    } else if (nextType === "lines") {
      onApplyDisplay({
        type: "lines",
        include: ["^Resolver\\s*:"],
        exclude: [],
      });
    } else if (nextType === "table") {
      onApplyDisplay({
        type: "table",
        format: "regex",
        regex: "^(?P<col1>\\S+)\\s+(?P<col2>.+)$",
        skip_lines: 0,
        columns: [
          { key: "col1", label: "Колонка 1", format: "mono" },
          { key: "col2", label: "Колонка 2" },
        ],
      });
    }
  }

  return html`<details class="form-section">
    <summary class="form-section-title" style="cursor:pointer">
      Оформление результата (display)${activeDisplay ? html` · <span class="badge ok">${curType}</span>` : html` · <span class="muted small">обычный вывод</span>`}
    </summary>
    <div class="stack" style="margin-top:10px">
      <p class="muted small">
        Задайте, какие поля или строки показывать сверху в карточке результата. Полный вывод останется доступным ниже в спойлере.
      </p>
      ${isSections
        ? html`<div class="muted small">Секция <b>sections</b> настроена напрямую в YAML.</div>`
        : html`
            <${Segmented}
              value=${curType}
              onChange=${switchType}
              options=${[
                { value: "none", label: "Обычный вывод" },
                { value: "kv", label: "Ключ–значение" },
                { value: "lines", label: "Фильтр строк" },
                { value: "table", label: "Таблица" },
              ]} />

            ${curType === "kv" ? html`<div class="stack">
              <div class="row">
                <div style="flex:0 0 140px">
                  <label>Формат</label>
                  <select value=${activeDisplay.format || "regex"}
                          onChange=${(e) => onApplyDisplay({ ...activeDisplay, format: e.target.value })}>
                    <option value="regex">regex</option>
                    <option value="json">json</option>
                  </select>
                </div>
                <div class="grow">
                  <label>Заголовок (опционально)</label>
                  <input value=${activeDisplay.title || ""}
                         onInput=${(e) => onApplyDisplay({ ...activeDisplay, title: e.target.value || undefined })} />
                </div>
              </div>
              ${(activeDisplay.fields || []).map((f, idx) => html`<div class="row" key=${idx} style="align-items:flex-end">
                <div style="flex:1">
                  <label>Подпись</label>
                  <input value=${f.label || ""}
                         onInput=${(e) => {
                           const next = (activeDisplay.fields || []).slice();
                           next[idx] = { ...f, label: e.target.value };
                           onApplyDisplay({ ...activeDisplay, fields: next });
                         }} />
                </div>
                <div style="flex:2">
                  <label>${(activeDisplay.format || "regex") === "regex" ? "Regex (группа 1)" : "JSON ключ"}</label>
                  <input class="mono"
                         value=${(activeDisplay.format || "regex") === "regex" ? (f.regex || "") : (f.key || "")}
                         onInput=${(e) => {
                           const next = (activeDisplay.fields || []).slice();
                           const patch = (activeDisplay.format || "regex") === "regex"
                             ? { regex: e.target.value }
                             : { key: e.target.value };
                           next[idx] = { ...f, ...patch };
                           onApplyDisplay({ ...activeDisplay, fields: next });
                         }} />
                </div>
                <button type="button" class="btn btn-sm btn-ghost"
                        title="Удалить поле"
                        onClick=${() => {
                          const next = (activeDisplay.fields || []).filter((_, j) => j !== idx);
                          onApplyDisplay({ ...activeDisplay, fields: next });
                        }}>×</button>
              </div>`)}
              <div class="row">
                <button type="button" class="btn btn-sm"
                        onClick=${() => onApplyDisplay({
                          ...activeDisplay,
                          fields: [...(activeDisplay.fields || []),
                            (activeDisplay.format || "regex") === "regex"
                              ? { label: "Поле", regex: "^Key\\s*:\\s*(.+)$" }
                              : { label: "Поле", key: "field" }],
                        })}>+ Поле</button>
              </div>
            </div>` : null}

            ${curType === "lines" ? html`<div class="stack">
              <div class="form-sub">
                <label>Показывать строки, подходящие под regex (по одному на строку)</label>
                <textarea class="mono llm-rule-cond" rows="3"
                          value=${(activeDisplay.include || []).join("\n")}
                          onInput=${(e) => {
                            const inc = e.target.value.split("\n").filter((x) => x.trim());
                            onApplyDisplay({ ...activeDisplay, include: inc });
                          }}></textarea>
              </div>
              <div class="form-sub">
                <label>Исключить строки (regex, опционально)</label>
                <textarea class="mono llm-rule-cond" rows="2"
                          value=${(activeDisplay.exclude || []).join("\n")}
                          onInput=${(e) => {
                            const exc = e.target.value.split("\n").filter((x) => x.trim());
                            onApplyDisplay({ ...activeDisplay, exclude: exc });
                          }}></textarea>
              </div>
            </div>` : null}

            ${curType === "table" ? html`<div class="stack">
              <div class="row">
                <div style="flex:0 0 140px">
                  <label>Формат</label>
                  <select value=${activeDisplay.format || "regex"}
                          onChange=${(e) => onApplyDisplay({ ...activeDisplay, format: e.target.value })}>
                    <option value="regex">regex</option>
                    <option value="json">json</option>
                  </select>
                </div>
                ${(activeDisplay.format || "regex") === "regex"
                  ? html`<div class="grow">
                        <label>Regex строки (группы (?P&lt;key&gt;...))</label>
                        <input class="mono" value=${activeDisplay.regex || ""}
                               onInput=${(e) => onApplyDisplay({ ...activeDisplay, regex: e.target.value })} />
                      </div>
                      <div style="flex:0 0 110px">
                        <label>Пропуск строк</label>
                        <input type="number" min="0" value=${activeDisplay.skip_lines || 0}
                               onInput=${(e) => onApplyDisplay({ ...activeDisplay, skip_lines: Number(e.target.value) })} />
                      </div>`
                  : html`<div class="grow">
                        <label>Путь к массиву в JSON (items_path)</label>
                        <input class="mono" placeholder="например filesystems" value=${activeDisplay.items_path || ""}
                               onInput=${(e) => onApplyDisplay({ ...activeDisplay, items_path: e.target.value })} />
                      </div>`}
              </div>
              ${(activeDisplay.columns || []).map((c, idx) => html`<div class="row" key=${idx} style="align-items:flex-end">
                <div style="flex:1">
                  <label>Ключ</label>
                  <input class="mono" value=${c.key || ""}
                         onInput=${(e) => {
                           const next = (activeDisplay.columns || []).slice();
                           next[idx] = { ...c, key: e.target.value };
                           onApplyDisplay({ ...activeDisplay, columns: next });
                         }} />
                </div>
                <div style="flex:1">
                  <label>Заголовок</label>
                  <input value=${c.label || ""}
                         onInput=${(e) => {
                           const next = (activeDisplay.columns || []).slice();
                           next[idx] = { ...c, label: e.target.value };
                           onApplyDisplay({ ...activeDisplay, columns: next });
                         }} />
                </div>
                <div style="flex:0 0 110px">
                  <label>Формат</label>
                  <select value=${c.format || ""}
                          onChange=${(e) => {
                            const next = (activeDisplay.columns || []).slice();
                            next[idx] = { ...c, format: e.target.value || undefined };
                            onApplyDisplay({ ...activeDisplay, columns: next });
                          }}>
                    <option value="">текст</option>
                    <option value="mono">mono</option>
                    <option value="bytes">bytes</option>
                    <option value="percent">percent</option>
                    <option value="number">number</option>
                  </select>
                </div>
                <button type="button" class="btn btn-sm btn-ghost"
                        title="Удалить колонку"
                        onClick=${() => {
                          const next = (activeDisplay.columns || []).filter((_, j) => j !== idx);
                          onApplyDisplay({ ...activeDisplay, columns: next });
                        }}>×</button>
              </div>`)}
              <div class="row">
                <button type="button" class="btn btn-sm"
                        onClick=${() => onApplyDisplay({
                          ...activeDisplay,
                          columns: [...(activeDisplay.columns || []), { key: "col", label: "Колонка" }],
                        })}>+ Колонка</button>
              </div>
            </div>` : null}
          `}

      ${activeDisplay
        ? html`<details>
            <summary class="muted small" style="cursor:pointer">Проверить на примере вывода</summary>
            <div class="stack" style="margin-top:8px">
              <textarea class="mono llm-rule-cond" rows="4"
                        placeholder="Вставьте пример вывода команды из терминала для проверки..."
                        value=${sampleOut}
                        onInput=${(e) => setSampleOut(e.target.value)}></textarea>
              ${sampleOut.trim()
                ? html`<div class="card" style="padding:10px">
                    <${OperationDisplayView} display=${activeDisplay} stdout=${sampleOut} />
                  </div>`
                : null}
            </div>
          </details>`
        : null}
    </div>
  </details>`;
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
  const [displayDraft, setDisplayDraft] = useState(undefined);
  const [flagsDraft, setFlagsDraft] = useState(undefined);

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
                      setDisplayDraft(undefined);
                      setFlagsDraft(undefined);
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

    ${(() => {
      const activeFlags = flagsDraft !== undefined
        ? flagsDraft
        : ((validation && validation.parsed && validation.parsed.flags) || {
            dangerous: false, state_changing: false, streaming: false,
            requires_confirmation: false, escalatable: false,
            idempotent: true, reversible: true,
          });
      const toggleFlag = (k, val) => {
        const next = { ...activeFlags, [k]: val };
        if (k === "state_changing" && val) next.requires_confirmation = true;
        setFlagsDraft(next);
        setYaml((cur) => replaceYamlFlagsSection(cur, next));
        setValidation(null);
      };
      return html`<details class="form-section">
        <summary class="form-section-title" style="cursor:pointer">
          Флаги выполнения${activeFlags.streaming ? html` · <span class="badge">stream</span>` : null}${activeFlags.state_changing ? html` · <span class="badge warn">state</span>` : null}
        </summary>
        <div class="stack" style="margin-top:10px; gap:8px">
          <label class="check">
            <input type="checkbox" checked=${!!activeFlags.streaming}
                   onChange=${(e) => toggleFlag("streaming", e.target.checked)} />
            <span>Потоковый вывод (streaming) — для бесконечных команд с кнопкой остановки (ping, tail -f)</span>
          </label>
          <label class="check">
            <input type="checkbox" checked=${!!activeFlags.state_changing}
                   onChange=${(e) => toggleFlag("state_changing", e.target.checked)} />
            <span>Меняет состояние (state_changing) — в реакциях всегда требует подтверждения</span>
          </label>
          <label class="check">
            <input type="checkbox" checked=${!!activeFlags.requires_confirmation}
                   onChange=${(e) => toggleFlag("requires_confirmation", e.target.checked)} />
            <span>Требовать подтверждение плана перед запуском (requires_confirmation)</span>
          </label>
          <label class="check">
            <input type="checkbox" checked=${!!activeFlags.escalatable}
                   onChange=${(e) => toggleFlag("escalatable", e.target.checked)} />
            <span>Опциональное sudo (escalatable) — выбор в UI с sudo или без</span>
          </label>
          <label class="check">
            <input type="checkbox" checked=${!!activeFlags.dangerous}
                   onChange=${(e) => toggleFlag("dangerous", e.target.checked)} />
            <span>Опасная операция (dangerous) — дополнительное предупреждение в плане</span>
          </label>
        </div>
      </details>`;
    })()}

    <${UserOpDisplayBuilder}
      activeDisplay=${displayDraft !== undefined ? displayDraft : (validation && validation.parsed ? validation.parsed.display : null)}
      onApplyDisplay=${(nextDisp) => {
        setDisplayDraft(nextDisp);
        setYaml((cur) => replaceYamlDisplaySection(cur, nextDisp));
        setValidation(null);
      }} />

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
              <span>категория: ${opCategoryLabel(op.category)}</span>
              ${renderLinksStatus(op.links, servers)}
              ${op.flags && op.flags.dangerous
                ? html`<span class="sev-critical">опасная</span>`
                : (op.flags && op.flags.state_changing
                    ? html`<span>меняет состояние</span>`
                    : html`<span>только чтение</span>`)}
              ${op.flags && op.flags.streaming ? html`<span>потоковая</span>` : null}
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


const SERVER_PALETTE = [
  "#38bdf8", // Sky blue
  "#34d399", // Emerald
  "#fbbf24", // Amber
  "#a78bfa", // Violet
  "#f472b6", // Rose
  "#fb923c", // Orange
  "#2dd4bf", // Teal
  "#a3e635", // Lime
  "#818cf8", // Indigo
  "#e879f9", // Fuchsia
];

function getServerColor(serverIndex) {
  if (serverIndex == null || serverIndex < 0) return "#9aa0a6";
  return SERVER_PALETTE[serverIndex % SERVER_PALETTE.length];
}

function truncateWithEllipsis(str, maxLen) {
  if (!str) return "";
  const s = String(str);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function splitLabelTwoLines(str, maxPerLine = 15) {
  if (!str) return ["", ""];
  const s = String(str);
  if (s.length <= maxPerLine) return [s, ""];
  const words = s.split(/\s+/);
  let line1 = "";
  let line2 = "";
  for (const w of words) {
    if (!line1 || (line1 + " " + w).length <= maxPerLine) {
      line1 = line1 ? line1 + " " + w : w;
    } else {
      line2 = line2 ? line2 + " " + w : w;
    }
  }
  if (!line2) {
    return [s.slice(0, maxPerLine), truncateWithEllipsis(s.slice(maxPerLine), maxPerLine)];
  }
  return [truncateWithEllipsis(line1, maxPerLine), truncateWithEllipsis(line2, maxPerLine)];
}

function AutomationGraphView({ initialServerId = null, isServerTab = false, onRefreshStatus }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // Фильтры тулбара
  const [selectedServerIds, setSelectedServerIds] = useState(() => (
    initialServerId != null ? new Set([Number(initialServerId)]) : new Set()
  ));
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [showGrid, setShowGrid] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);

  // Режим отображения правил: all (все) | enabled (только on) | hidden (выкл/скрыты)
  const [rulesMode, setRulesMode] = useState("all");

  const [typeFilters, setTypeFilters] = useState({
    servers: true,
    ops: true,
    reactions: true,
  });

  // Полноэкранный режим
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Модалки
  const [modalState, setModalState] = useState(null);

  // Контекстное меню ПКМ
  const [contextMenu, setContextMenu] = useState(null);

  // Pan / Zoom холста
  const [pan, setPan] = useState({ x: 340, y: 240 });
  const [zoom, setZoom] = useState(1.0);
  const panRef = useRef({ x: 340, y: 240 }); panRef.current = pan;
  const zoomRef = useRef(1.0); zoomRef.current = zoom;
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const hasCenteredRef = useRef(false);

  // Выделение узлов и разделение клика / drag
  const [hoveredId, setHoveredId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [inspectorData, setInspectorData] = useState(null);
  const didDragNodeRef = useRef(false);

  // Радиальная физика + Alpha Decay
  const simNodesRef = useRef([]);
  const simEdgesRef = useRef([]);
  const animFrameRef = useRef(null);
  const alphaRef = useRef(0);
  const draggedNodeRef = useRef(null);

  const nodeElMap = useRef(new Map());
  const edgeElMap = useRef(new Map());

  async function loadGraph() {
    setLoading(true);
    setErr("");
    try {
      const res = await api("/api/v1/automation/graph");
      setData(res);
      if (initialServerId == null) {
        setSelectedServerIds(new Set((res.servers || []).map((s) => s.id)));
      }
      initSimulation(res);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadGraph(); }, []);

  // Первичное центрирование ровно один раз
  useEffect(() => {
    if (!hasCenteredRef.current && data && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 50) {
        hasCenteredRef.current = true;
        setPan({ x: Math.round(rect.width / 2), y: Math.round(rect.height / 2) });
      }
    }
  }, [data]);

  // Reheat при смене фильтров
  useEffect(() => {
    if (data && simNodesRef.current.length > 0) {
      startSimulation(0.4);
    }
  }, [
    selectedServerIds,
    rulesMode,
    typeFilters.servers,
    typeFilters.ops,
    typeFilters.reactions,
    searchQ,
  ]);

  // Выход из полноэкранного режима по Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        if (contextMenu) setContextMenu(null);
        else if (isFullscreen) setIsFullscreen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFullscreen, contextMenu]);

  // Закрытие контекстного меню и дропдауна серверов
  useEffect(() => {
    if (!contextMenu && !serverPickerOpen) return undefined;
    function onDoc(e) {
      if (!e.target.closest(".graph-context-menu")) setContextMenu(null);
      if (!e.target.closest(".graph-server-picker-wrap")) setServerPickerOpen(false);
    }
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [contextMenu, serverPickerOpen]);

  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  function initSimulation(raw) {
    if (!raw) return;
    const { servers = [], operations = [], alert_rules = [], reaction_rules = [] } = raw;

    const rawNodes = [];
    const rawEdges = [];

    const serverColorMap = new Map();
    servers.forEach((s, idx) => {
      serverColorMap.set(s.id, { color: getServerColor(idx), idx });
    });

    const opById = new Map(operations.map((o) => [o.id, o]));

    const sCount = servers.length;
    const serverAnchors = new Map();
    const serverOutward = new Map();

    if (sCount === 1) {
      serverAnchors.set(servers[0].id, { x: -160, y: 0 });
      serverOutward.set(servers[0].id, { x: -1, y: 0 });
    } else if (sCount === 2) {
      serverAnchors.set(servers[0].id, { x: -240, y: 0 });
      serverOutward.set(servers[0].id, { x: -1, y: 0 });
      serverAnchors.set(servers[1].id, { x: 240, y: 0 });
      serverOutward.set(servers[1].id, { x: 1, y: 0 });
    } else if (sCount === 3) {
      const rad = 280;
      const angles = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6];
      servers.forEach((s, idx) => {
        const a = angles[idx];
        const ox = Math.cos(a), oy = Math.sin(a);
        serverAnchors.set(s.id, { x: ox * rad, y: oy * rad });
        serverOutward.set(s.id, { x: ox, y: oy });
      });
    } else if (sCount === 4) {
      const sx = 260, sy = 200;
      const coords = [
        { x: -sx, y: -sy }, { x: sx, y: -sy },
        { x: -sx, y: sy },  { x: sx, y: sy },
      ];
      servers.forEach((s, idx) => {
        const c = coords[idx];
        const len = Math.sqrt(c.x * c.x + c.y * c.y) || 1;
        serverAnchors.set(s.id, c);
        serverOutward.set(s.id, { x: c.x / len, y: c.y / len });
      });
    } else {
      const rad = Math.max(300, sCount * 90);
      servers.forEach((s, idx) => {
        const a = (idx / Math.max(1, sCount)) * 2 * Math.PI;
        const ox = Math.cos(a), oy = Math.sin(a);
        serverAnchors.set(s.id, { x: ox * rad, y: oy * rad });
        serverOutward.set(s.id, { x: ox, y: oy });
      });
    }

    // Серверы
    servers.forEach((s) => {
      const anc = serverAnchors.get(s.id) || { x: 0, y: 0 };
      const sColor = serverColorMap.get(s.id)?.color || "#38bdf8";
      rawNodes.push({
        id: `srv_${s.id}`,
        label: s.name,
        sub: s.llm_alias,
        type: "server",
        w: 175, h: 54,
        radius: 135,
        initX: anc.x,
        initY: anc.y,
        isServer: true,
        themeColor: sColor,
        data: s,
      });
    });

    // Операции
    operations.forEach((o) => {
      const sids = Array.isArray(o.server_ids) ? o.server_ids : [];
      let ix = (Math.random() - 0.5) * 140;
      let iy = (Math.random() - 0.5) * 140;
      let primaryColor = "var(--border-strong)";

      if (sids.length === 1 && serverAnchors.has(sids[0])) {
        const anc = serverAnchors.get(sids[0]);
        const out = serverOutward.get(sids[0]);
        ix = anc.x + out.x * 220 + (Math.random() - 0.5) * 60;
        iy = anc.y + out.y * 220 + (Math.random() - 0.5) * 60;
        primaryColor = serverColorMap.get(sids[0])?.color || primaryColor;
      }

      rawNodes.push({
        id: `op_${o.id}`,
        label: o.name,
        sub: o.id,
        type: "operation",
        w: 150, h: 42,
        radius: 110,
        initX: ix,
        initY: iy,
        isServer: false,
        themeColor: primaryColor,
        data: o,
      });

      if (o.is_global) {
        servers.forEach((s) => {
          const edgeColor = serverColorMap.get(s.id)?.color || "var(--border-strong)";
          rawEdges.push({ source: `srv_${s.id}`, target: `op_${o.id}`, type: "global", rest: 280, color: edgeColor });
        });
      } else if (sids.length > 0) {
        sids.forEach((sid) => {
          const edgeColor = serverColorMap.get(sid)?.color || "var(--border-strong)";
          rawEdges.push({ source: `srv_${sid}`, target: `op_${o.id}`, type: "explicit", rest: 220, color: edgeColor });
        });
      }
    });

    // Правила алертов
    alert_rules.forEach((r) => {
      const sj = r.servers_json || {};
      const hasSpecificIds = Array.isArray(sj.ids) && sj.ids.length > 0;
      const isAllServers = (r.server_id == null) && (!hasSpecificIds || sj.all === true);
      const singleSid = r.server_id != null ? r.server_id : (hasSpecificIds && sj.ids.length === 1 ? sj.ids[0] : null);

      let ix = (Math.random() - 0.5) * 180;
      let iy = (Math.random() - 0.5) * 180;
      let primaryColor = "var(--border-strong)";

      if (singleSid != null && serverAnchors.has(singleSid)) {
        const anc = serverAnchors.get(singleSid);
        const out = serverOutward.get(singleSid);
        ix = anc.x + out.x * 210 + (Math.random() - 0.5) * 60;
        iy = anc.y + out.y * 210 + (Math.random() - 0.5) * 60;
        primaryColor = serverColorMap.get(singleSid)?.color || primaryColor;
      }

      rawNodes.push({
        id: `rule_${r.id}`,
        label: r.name,
        sub: conditionKindLabel(r.condition_kind),
        type: "alert_rule",
        w: 160, h: 46,
        radius: 115,
        initX: ix,
        initY: iy,
        isServer: false,
        themeColor: primaryColor,
        data: r,
      });

      if (r.condition_kind === "operation_check" && r.operation_id) {
        rawEdges.push({ source: `op_${r.operation_id}`, target: `rule_${r.id}`, type: "explicit", rest: 210, color: primaryColor });
      }

      if (r.server_id != null) {
        const edgeColor = serverColorMap.get(r.server_id)?.color || "var(--border-strong)";
        rawEdges.push({ source: `srv_${r.server_id}`, target: `rule_${r.id}`, type: "explicit", rest: 220, color: edgeColor });
      } else if (hasSpecificIds) {
        sj.ids.forEach((sid) => {
          const edgeColor = serverColorMap.get(sid)?.color || "var(--border-strong)";
          rawEdges.push({ source: `srv_${sid}`, target: `rule_${r.id}`, type: "explicit", rest: 220, color: edgeColor });
        });
      } else if (isAllServers) {
        servers.forEach((s) => {
          const edgeColor = serverColorMap.get(s.id)?.color || "var(--border-strong)";
          rawEdges.push({ source: `srv_${s.id}`, target: `rule_${r.id}`, type: "global", rest: 290, color: edgeColor });
        });
      }
    });

    // Реакции — размещаем на внешней орбите и связываем с защищаемыми серверами
    const rxCount = Math.max(1, reaction_rules.length);
    reaction_rules.forEach((rx, rIdx) => {
      let primaryColor = "#b794f6";
      const match = rx.match || {};
      const matchSrvs = Array.isArray(match.server_ids) ? match.server_ids : [];

      if (rx.run_on_server && rx.run_on_server !== "same_as_alert") {
        const sid = Number(rx.run_on_server);
        if (serverColorMap.has(sid)) primaryColor = serverColorMap.get(sid).color;
      } else if (matchSrvs.length === 1 && serverColorMap.has(matchSrvs[0])) {
        primaryColor = serverColorMap.get(matchSrvs[0]).color;
      }

      // Начальная позиция на внешней орбите (R = 400)
      const angle = (rIdx / rxCount) * 2 * Math.PI + Math.PI / 4;
      const rxInitX = Math.cos(angle) * 400;
      const rxInitY = Math.sin(angle) * 400;

      rawNodes.push({
        id: `rx_${rx.id}`,
        label: rx.name,
        sub: `${rx.action_policy} · sudo: ${rx.sudo_mode}`,
        type: "reaction_rule",
        w: 160, h: 46,
        radius: 125,
        initX: rxInitX,
        initY: rxInitY,
        isServer: false,
        isReaction: true,
        themeColor: primaryColor,
        data: rx,
      });

      if (rx.operation_id) {
        rawEdges.push({ source: `rx_${rx.id}`, target: `op_${rx.operation_id}`, type: "explicit", rest: 260, color: primaryColor });
      }

      // Связи к правилам алертов
      const rids = match.rule_ids || [];
      if (rids.length) {
        rids.forEach((rid) => {
          rawEdges.push({ source: `rule_${rid}`, target: `rx_${rx.id}`, type: "explicit", rest: 260, color: primaryColor });
        });
      } else if (Array.isArray(match.condition_kinds) && match.condition_kinds.length) {
        alert_rules.forEach((ar) => {
          if (match.condition_kinds.includes(ar.condition_kind)) {
            rawEdges.push({ source: `rule_${ar.id}`, target: `rx_${rx.id}`, type: "implicit", rest: 280, color: primaryColor });
          }
        });
      } else {
        alert_rules.forEach((ar) => {
          rawEdges.push({ source: `rule_${ar.id}`, target: `rx_${rx.id}`, type: "implicit", rest: 280, color: primaryColor });
        });
      }

      // Связи к серверам: учитываем run_on_server, match.server_ids и применимость операции
      let targetSrvIds = [];
      let isRxGlobalSrv = false;
      if (rx.run_on_server && rx.run_on_server !== "same_as_alert") {
        targetSrvIds = [Number(rx.run_on_server)];
      } else if (matchSrvs.length > 0) {
        targetSrvIds = matchSrvs.map(Number);
      } else {
        isRxGlobalSrv = true;
        const opObj = opById.get(rx.operation_id);
        if (!opObj || opObj.is_global) {
          targetSrvIds = servers.map((s) => s.id);
        } else if (Array.isArray(opObj.server_ids)) {
          targetSrvIds = opObj.server_ids.slice();
        }
      }

      targetSrvIds.forEach((sid) => {
        const edgeColor = serverColorMap.get(sid)?.color || primaryColor;
        rawEdges.push({
          source: `rx_${rx.id}`,
          target: `srv_${sid}`,
          type: isRxGlobalSrv ? "global" : "explicit",
          rest: 360,
          color: edgeColor,
        });
      });
    });

    const existingPos = new Map(simNodesRef.current.map((n) => [n.id, { x: n.x, y: n.y }]));

    simNodesRef.current = rawNodes.map((n) => {
      const prev = existingPos.get(n.id);
      return {
        ...n,
        x: prev ? prev.x : n.initX,
        y: prev ? prev.y : n.initY,
        vx: 0,
        vy: 0,
      };
    });
    simEdgesRef.current = rawEdges;
    startSimulation(1.0);
  }

  function startSimulation(initialAlpha = 1.0) {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    alphaRef.current = Math.max(alphaRef.current, initialAlpha);

    function step() {
      const nodes = simNodesRef.current.filter((n) => isNodeVisible(n));
      const edges = simEdgesRef.current.filter((e) => {
        const u = simNodesRef.current.find((n) => n.id === e.source);
        const v = simNodesRef.current.find((n) => n.id === e.target);
        return u && v && isNodeVisible(u) && isNodeVisible(v);
      });

      if (!nodes.length) {
        animFrameRef.current = null;
        return;
      }

      const alpha = alphaRef.current;
      if (alpha < 0.005 && !draggedNodeRef.current) {
        animFrameRef.current = null;
        return;
      }

      const damping = 0.81;

      // 1. Радиальное расталкивание + барьер серверов 50px + отталкивание реакций
      for (let i = 0; i < nodes.length; i++) {
        const u = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const v = nodes[j];

          let dx = v.x - u.x;
          let dy = v.y - u.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 1) {
            dx = (Math.random() - 0.5) || 1;
            dy = (Math.random() - 0.5) || 1;
            dist = Math.sqrt(dx * dx + dy * dy);
          }

          const isServers = u.isServer && v.isServer;
          const isRxSrv = (u.isReaction && v.isServer) || (v.isReaction && u.isServer);
          const isReactions = u.isReaction && v.isReaction;
          const nx = dx / dist;
          const ny = dy / dist;

          if (isServers) {
            const minServerDist = 2 * (87.5 * Math.abs(nx) + 27 * Math.abs(ny)) + 50;
            if (dist < minServerDist) {
              const overlap = minServerDist - dist;
              const push = Math.max(2.0, overlap * 0.45);
              if (draggedNodeRef.current !== u) { u.x -= nx * push * 0.5; u.y -= ny * push * 0.5; }
              if (draggedNodeRef.current !== v) { v.x += nx * push * 0.5; v.y += ny * push * 0.5; }
            } else {
              const force = (4500 / (dist * dist)) * alpha;
              const fx = nx * Math.min(force, 8.0);
              const fy = ny * Math.min(force, 8.0);
              if (draggedNodeRef.current !== u) { u.vx -= fx; u.vy -= fy; }
              if (draggedNodeRef.current !== v) { v.vx += fx; v.vy += fy; }
            }
          } else if (isRxSrv) {
            // Реакции держат дистанцию от серверов и не лезут в их кластеры
            const minRxSrvDist = 310;
            if (dist < minRxSrvDist) {
              const overlap = minRxSrvDist - dist;
              const push = (overlap / minRxSrvDist) * 10.0 * alpha;
              if (draggedNodeRef.current !== u) { u.vx -= nx * push; u.vy -= ny * push; }
              if (draggedNodeRef.current !== v) { v.vx += nx * push; v.vy += ny * push; }
            } else {
              const force = (3500 / (dist * dist)) * alpha;
              const fx = nx * Math.min(force, 8.0);
              const fy = ny * Math.min(force, 8.0);
              if (draggedNodeRef.current !== u) { u.vx -= fx; u.vy -= fy; }
              if (draggedNodeRef.current !== v) { v.vx += fx; v.vy += fy; }
            }
          } else {
            const extraGap = isReactions ? 65 : 48;
            const minDist = u.radius + v.radius + extraGap;
            if (dist < minDist) {
              const overlap = minDist - dist;
              const push = (overlap / minDist) * 7.5 * alpha;
              const fx = nx * push;
              const fy = ny * push;
              if (draggedNodeRef.current !== u) { u.vx -= fx; u.vy -= fy; }
              if (draggedNodeRef.current !== v) { v.vx += fx; v.vy += fy; }
            } else {
              const force = ((isReactions ? 4000 : 2500) / (dist * dist)) * alpha;
              const fx = nx * Math.min(force, 8.0);
              const fy = ny * Math.min(force, 8.0);
              if (draggedNodeRef.current !== u) { u.vx -= fx; u.vy -= fy; }
              if (draggedNodeRef.current !== v) { v.vx += fx; v.vy += fy; }
            }
          }
        }
      }

      // 2. Пружины связей
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      for (let k = 0; k < edges.length; k++) {
        const e = edges[k];
        const u = nodeMap.get(e.source);
        const v = nodeMap.get(e.target);
        if (!u || !v) continue;

        let dx = v.x - u.x;
        let dy = v.y - u.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;

        const rest = e.rest || 220;
        const delta = dist - rest;
        const springK = (e.type === "global" || e.type === "implicit") ? 0.015 : 0.035;
        const force = delta * springK * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (draggedNodeRef.current !== u) { u.vx += fx; u.vy += fy; }
        if (draggedNodeRef.current !== v) { v.vx -= fx; v.vy -= fy; }
      }

      // 3. Орбитальная гравитация: реакции — на внешнее кольцо (R=400), остальные — мягко к центру
      const centerG = 0.00045;
      for (let i = 0; i < nodes.length; i++) {
        const u = nodes[i];
        if (draggedNodeRef.current === u) continue;

        if (u.isReaction) {
          const rDist = Math.sqrt(u.x * u.x + u.y * u.y) || 1;
          const targetR = 400;
          const radialForce = (targetR - rDist) * 0.015 * alpha;
          u.vx += (u.x / rDist) * radialForce;
          u.vy += (u.y / rDist) * radialForce;
        } else {
          u.vx -= u.x * centerG * alpha;
          u.vy -= u.y * centerG * alpha;
        }

        u.vx = Math.max(-35, Math.min(35, u.vx * damping));
        u.vy = Math.max(-35, Math.min(35, u.vy * damping));

        u.x = Math.max(-3000, Math.min(3000, u.x + u.vx));
        u.y = Math.max(-3000, Math.min(3000, u.y + u.vy));
        if (!Number.isFinite(u.x)) u.x = 0;
        if (!Number.isFinite(u.y)) u.y = 0;
      }

      if (!draggedNodeRef.current) {
        alphaRef.current *= 0.965;
      }

      renderGraphNodes();
      animFrameRef.current = requestAnimationFrame(step);
    }

    animFrameRef.current = requestAnimationFrame(step);
  }

  function renderGraphNodes() {
    const nodes = simNodesRef.current;
    const edges = simEdgesRef.current;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const el = nodeElMap.current.get(n.id);
      if (el) el.setAttribute("transform", `translate(${Math.round(n.x)}, ${Math.round(n.y)})`);
    }

    for (let i = 0; i < edges.length; i++) {
      const el = edgeElMap.current.get(i);
      if (!el) continue;
      const e = edges[i];
      const u = nodeMap.get(e.source);
      const v = nodeMap.get(e.target);
      if (u && v) {
        el.setAttribute("x1", Math.round(u.x));
        el.setAttribute("y1", Math.round(u.y));
        el.setAttribute("x2", Math.round(v.x));
        el.setAttribute("y2", Math.round(v.y));
      }
    }
  }

  const qStr = searchQ.trim().toLowerCase();

  const connectedIdsForFilteredServers = useMemo(() => {
    if (!data) return null;
    const totalServers = (data.servers || []).length;
    if (selectedServerIds.size === totalServers && totalServers > 0) return null;
    const connected = new Set();

    selectedServerIds.forEach((sid) => connected.add(`srv_${sid}`));

    (data.operations || []).forEach((o) => {
      if (o.is_global) {
        connected.add(`op_${o.id}`);
      } else if (Array.isArray(o.server_ids) && o.server_ids.some((sid) => selectedServerIds.has(sid))) {
        connected.add(`op_${o.id}`);
      }
    });

    (data.alert_rules || []).forEach((r) => {
      const sj = r.servers_json || {};
      const hasSpecificIds = Array.isArray(sj.ids) && sj.ids.length > 0;
      const isAllServers = (r.server_id == null) && (!hasSpecificIds || sj.all === true);
      const matchesSrv = (r.server_id != null && selectedServerIds.has(r.server_id))
        || (hasSpecificIds && sj.ids.some((sid) => selectedServerIds.has(sid)))
        || isAllServers;
      if (matchesSrv) connected.add(`rule_${r.id}`);
    });

    const opById = new Map((data.operations || []).map((o) => [o.id, o]));
    (data.reaction_rules || []).forEach((rx) => {
      const match = rx.match || {};
      const matchSrvs = Array.isArray(match.server_ids) ? match.server_ids : [];
      if (rx.run_on_server && rx.run_on_server !== "same_as_alert") {
        if (selectedServerIds.has(Number(rx.run_on_server))) connected.add(`rx_${rx.id}`);
      } else if (matchSrvs.length > 0) {
        if (matchSrvs.some((sid) => selectedServerIds.has(Number(sid)))) connected.add(`rx_${rx.id}`);
      } else {
        const opObj = opById.get(rx.operation_id);
        if (!opObj || opObj.is_global) {
          if (selectedServerIds.size > 0) connected.add(`rx_${rx.id}`);
        } else if (Array.isArray(opObj.server_ids) && opObj.server_ids.some((sid) => selectedServerIds.has(sid))) {
          connected.add(`rx_${rx.id}`);
        }
      }
    });

    return connected;
  }, [selectedServerIds, data]);

  const highlightFocusId = selectedId || hoveredId;
  const highlightNeighbors = useMemo(() => {
    if (!highlightFocusId) return null;
    const set = new Set([highlightFocusId]);
    (simEdgesRef.current || []).forEach((e) => {
      if (e.source === highlightFocusId) set.add(e.target);
      if (e.target === highlightFocusId) set.add(e.source);
    });
    return set;
  }, [highlightFocusId]);

  function isNodeVisible(n) {
    if (n.type === "server" && !typeFilters.servers) return false;
    if (n.type === "operation" && !typeFilters.ops) return false;
    if (n.type === "reaction_rule" && !typeFilters.reactions) return false;

    if (n.type === "alert_rule") {
      if (rulesMode === "hidden") return false;
      if (rulesMode === "enabled" && !n.data.enabled) return false;
    }

    if (connectedIdsForFilteredServers && !connectedIdsForFilteredServers.has(n.id)) return false;

    if (qStr) {
      const matchLbl = n.label.toLowerCase().includes(qStr);
      const matchSub = (n.sub || "").toLowerCase().includes(qStr);
      if (!matchLbl && !matchSub) return false;
    }
    return true;
  }

  // Pan / Zoom
  function onWheel(e) {
    e.preventDefault();
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const curZoom = zoomRef.current;
    const nextZoom = Math.max(0.25, Math.min(2.8, curZoom * factor));
    const nextPanX = mouseX - (mouseX - panRef.current.x) * (nextZoom / curZoom);
    const nextPanY = mouseY - (mouseY - panRef.current.y) * (nextZoom / curZoom);
    setZoom(nextZoom);
    setPan({ x: nextPanX, y: nextPanY });
  }

  // Панорамирование: СКМ (e.button === 1) работает с любого места (включая узлы),
  // ЛКМ (e.button === 0) — только по пустому фону и снимает выделение.
  function onSvgPointerDown(e) {
    if (e.button === 1) {
      e.preventDefault();
      setContextMenu(null);
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (
      e.target.closest(".graph-node-group")
      || e.target.closest("button")
      || e.target.closest(".graph-inspector")
      || e.target.closest(".graph-legend-wrap")
    ) return;
    setSelectedId(null);
    setInspectorData(null);
    setContextMenu(null);
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onSvgPointerMove(e) {
    if (isPanningRef.current) {
      setPan({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
    }
  }

  function onSvgPointerUp(e) {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    }
  }

  function centerGraph() {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    setPan({ x: Math.round(rect.width / 2), y: Math.round(rect.height / 2) });
    setZoom(1.0);
    startSimulation(0.6);
  }

  function toggleFullscreen() {
    setIsFullscreen((prev) => !prev);
    setTimeout(() => centerGraph(), 40);
  }

  function openGraphModal(st) {
    setInspectorData(null);
    setLegendOpen(false);
    setModalState(st);
  }

  function openInspectorForNode(node) {
    setSelectedId(node.id);
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const screenX = panRef.current.x + node.x * zoomRef.current;
    const screenY = panRef.current.y + node.y * zoomRef.current;
    const cardW = 270;
    const cardH = 210;

    let left = screenX + (node.w / 2) * zoomRef.current + 16;
    if (left + cardW > rect.width - 12) {
      left = screenX - (node.w / 2) * zoomRef.current - cardW - 16;
    }
    left = Math.max(12, Math.min(left, rect.width - cardW - 12));

    let top = screenY - 30;
    if (top + cardH > rect.height - 12) {
      top = Math.max(12, rect.height - cardH - 12);
    }
    top = Math.max(12, top);

    setInspectorData({
      node,
      style: `left: ${Math.round(left)}px; top: ${Math.round(top)}px;`,
    });
  }

  function onNodeClick(e, node) {
    e.stopPropagation();
    // Если узел перетаскивали — клик игнорируем
    if (didDragNodeRef.current) {
      didDragNodeRef.current = false;
      return;
    }
    if (selectedId === node.id && inspectorData) {
      setSelectedId(null);
      setInspectorData(null);
      return;
    }
    openInspectorForNode(node);
  }

  function onNodePointerDown(e, node) {
    // При СКМ (button === 1) не останавливаем всплытие: отдаём панорамированию холста
    if (e.button === 1) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    draggedNodeRef.current = node;
    didDragNodeRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = node.x;
    const origY = node.y;

    function onMove(ev) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        didDragNodeRef.current = true;
      }
      const z = zoomRef.current;
      node.x = origX + (ev.clientX - startX) / z;
      node.y = origY + (ev.clientY - startY) / z;
      node.vx = 0;
      node.vy = 0;
      startSimulation(0.2);
    }

    function onUp() {
      draggedNodeRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      startSimulation(0.3);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onCanvasContextMenu(e) {
    e.preventDefault();
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 230),
      items: [
        { label: "+ Новая операция", action: () => openGraphModal({ type: "new_op" }) },
        { label: "+ Новое правило алерта", action: () => openGraphModal({ type: "new_rule" }) },
        { label: "+ Новая реакция", action: () => openGraphModal({ type: "new_rx" }) },
        { sep: true },
        { label: "⤢ По центру", action: centerGraph },
        { label: isFullscreen ? "🗗 Свернуть окно" : "⛶ Во весь экран", action: toggleFullscreen },
        { label: showGrid ? "• Сетка: выключить" : "• Сетка: включить", action: () => setShowGrid(!showGrid) },
      ],
    });
  }

  function onNodeContextMenu(e, node) {
    e.preventDefault();
    e.stopPropagation();
    // ПКМ подсвечивает узел и открывает ТОЛЬКО меню (без карточки инспектора)
    setSelectedId(node.id);
    setInspectorData(null);

    const items = [];
    if (node.type === "server") {
      items.push({
        label: "Открыть сервер",
        action: () => window.dispatchEvent(new CustomEvent("melecho:open-server", { detail: { id: node.data.id } })),
      });
    } else if (node.type === "operation") {
      const clean = node.data.id.startsWith("user:") ? node.data.id.slice(5) : node.data.id;
      if (node.data.source === "user") {
        items.push({ label: "Правка операции", action: () => openGraphModal({ type: "edit_op", oid: clean }) });
      }
    } else if (node.type === "alert_rule") {
      items.push({ label: "Подробнее", action: () => openGraphModal({ type: "view_rule", id: node.data.id }) });
      items.push({
        label: "Правка правила",
        action: () => openGraphModal({ type: "edit_rule", id: node.data.id, initial: alertRuleToEditorInitial(node.data) }),
      });
      items.push({
        label: node.data.enabled ? "Отключить правило" : "Включить правило",
        action: async () => {
          await api("/api/v1/alert-rules/" + node.data.id, {
            method: "PATCH",
            body: JSON.stringify({ enabled: !node.data.enabled }),
          });
          await loadGraph();
          onRefreshStatus && onRefreshStatus();
        },
      });
    } else if (node.type === "reaction_rule") {
      items.push({ label: "Правка реакции", action: () => openGraphModal({ type: "edit_rx", id: node.data.id }) });
      items.push({
        label: node.data.enabled ? "Отключить реакцию" : "Включить реакцию",
        action: async () => {
          await api("/api/v1/reaction-rules/" + node.data.id, {
            method: "PATCH",
            body: JSON.stringify({ enabled: !node.data.enabled }),
          });
          await loadGraph();
          onRefreshStatus && onRefreshStatus();
        },
      });
    }

    items.push({ sep: true });
    items.push({ label: isFullscreen ? "🗗 Свернуть окно" : "⛶ Во весь экран", action: toggleFullscreen });

    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 230),
      items,
    });
  }

  function cycleRulesMode() {
    setRulesMode((prev) => (prev === "all" ? "enabled" : prev === "enabled" ? "hidden" : "all"));
  }

  const rulesBtnLabel = rulesMode === "all" ? "Правила: Все" : (rulesMode === "enabled" ? "Правила: Только on" : "Правила: Выкл");
  const rulesBtnTip = rulesMode === "all"
    ? "Правила: отображаются все (включённые и отключённые)"
    : (rulesMode === "enabled" ? "Правила: отображаются только активные (on)" : "Правила: полностью скрыты с холста");

  const allServers = data?.servers || [];
  const allSelected = allServers.length > 0 && selectedServerIds.size === allServers.length;
  const serverBtnLabel = allSelected
    ? `Серверы: Все (${allServers.length})`
    : (selectedServerIds.size === 0 ? "Серверы: 0" : `Серверы: ${selectedServerIds.size} из ${allServers.length}`);

  function toggleServerId(sid) {
    const next = new Set(selectedServerIds);
    if (next.has(sid)) next.delete(sid);
    else next.add(sid);
    setSelectedServerIds(next);
  }

  return html`<div class=${"graph-container" + (isFullscreen ? " fullscreen" : "")} ref=${containerRef}>
    <div class="graph-toolbar stack" style="gap:8px">
      <!-- Строка 1: фильтры и вид -->
      <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
        <div class="graph-server-picker-wrap">
          <button type="button" class="btn btn-sm" onClick=${() => setServerPickerOpen(!serverPickerOpen)}>
            ${serverBtnLabel} ▾
          </button>
          ${serverPickerOpen ? html`
            <div class="graph-server-picker-dropdown card stack">
              <div class="row" style="gap:6px; margin-bottom:4px">
                <button type="button" class="btn btn-sm btn-ghost small"
                        onClick=${() => setSelectedServerIds(new Set(allServers.map((s) => s.id)))}>
                  Все
                </button>
                <button type="button" class="btn btn-sm btn-ghost small"
                        onClick=${() => setSelectedServerIds(new Set())}>
                  Сбросить
                </button>
              </div>
              <div class="stack" style="gap:4px; max-height:220px; overflow-y:auto">
                ${allServers.map((s, idx) => {
                  const sColor = getServerColor(idx);
                  return html`<label class="check small" key=${s.id} style="gap:6px; cursor:pointer">
                    <input type="checkbox" checked=${selectedServerIds.has(s.id)}
                           onChange=${() => toggleServerId(s.id)} />
                    <span style=${`display:inline-block; width:8px; height:8px; border-radius:50%; background:${sColor}`}></span>
                    <span>${s.name} <span class="muted mono">(${s.llm_alias})</span></span>
                  </label>`;
                })}
              </div>
            </div>
          ` : null}
        </div>

        <input class="graph-search-input"
               placeholder="Поиск по графу…"
               value=${searchQ}
               onInput=${(e) => setSearchQ(e.target.value)} />

        <div class="row" style="gap:4px">
          <button type="button"
                  class=${"btn btn-sm " + (typeFilters.servers ? "btn-primary" : "btn-ghost")}
                  onClick=${() => setTypeFilters({ ...typeFilters, servers: !typeFilters.servers })}>
            Серверы
          </button>
          <button type="button"
                  class=${"btn btn-sm " + (typeFilters.ops ? "btn-primary" : "btn-ghost")}
                  onClick=${() => setTypeFilters({ ...typeFilters, ops: !typeFilters.ops })}>
            Операции
          </button>
          <button type="button"
                  class=${"btn btn-sm " + (rulesMode !== "hidden" ? "btn-primary" : "btn-ghost")}
                  onClick=${cycleRulesMode}
                  title=${rulesBtnTip}>
            ${rulesBtnLabel}
          </button>
          <button type="button"
                  class=${"btn btn-sm " + (typeFilters.reactions ? "btn-primary" : "btn-ghost")}
                  onClick=${() => setTypeFilters({ ...typeFilters, reactions: !typeFilters.reactions })}>
            Реакции
          </button>
        </div>

        <div class="grow"></div>

        <button type="button" class="btn btn-sm btn-ghost" onClick=${() => setShowGrid(!showGrid)} title="Переключить фон">
          ${showGrid ? "• Сетка: вкл" : "• Сетка: выкл"}
        </button>
        <button type="button" class="btn btn-sm btn-ghost" onClick=${centerGraph} title="Центрировать">
          ⤢ По центру
        </button>
      </div>

      <!-- Строка 2: действия создания слева, полноэкранный режим справа -->
      <div class="row" style="gap:8px; align-items:center">
        <div class="row" style="gap:6px">
          <button type="button" class="btn btn-sm btn-graph-action" onClick=${() => openGraphModal({ type: "new_op" })}>+ Операция</button>
          <button type="button" class="btn btn-sm btn-graph-action" onClick=${() => openGraphModal({ type: "new_rule" })}>+ Правило</button>
          <button type="button" class="btn btn-sm btn-graph-action" onClick=${() => openGraphModal({ type: "new_rx" })}>+ Реакция</button>
        </div>
        <div class="grow"></div>
        <button type="button"
                class="btn btn-sm btn-ghost"
                onClick=${toggleFullscreen}
                title="Полноэкранный режим (Escape — выход)">
          ${isFullscreen ? "🗗 Свернуть" : "⛶ Во весь экран"}
        </button>
      </div>
    </div>

    ${err ? html`<div class="banner danger">${err}</div>` : null}

    <div class="graph-canvas-wrap"
         ref=${svgRef}
         onWheel=${onWheel}
         onAuxClick=${(e) => { if (e.button === 1) e.preventDefault(); }}
         onPointerDown=${onSvgPointerDown}
         onPointerMove=${onSvgPointerMove}
         onPointerUp=${onSvgPointerUp}
         onContextMenu=${onCanvasContextMenu}>
      <svg class="graph-svg" width="100%" height="100%">
        <defs>
          <pattern id="dot-grid"
                   x=${((pan.x % (24 * zoom)) + 24 * zoom) % (24 * zoom)}
                   y=${((pan.y % (24 * zoom)) + 24 * zoom) % (24 * zoom)}
                   width=${24 * zoom}
                   height=${24 * zoom}
                   patternUnits="userSpaceOnUse">
            <circle cx=${12 * zoom}
                    cy=${12 * zoom}
                    r=${Math.max(1.0, 1.3 * Math.min(zoom, 1.4))}
                    fill="var(--fg-subtle)"
                    opacity=${showGrid ? "0.32" : "0"} />
          </pattern>
        </defs>

        <rect width="100%" height="100%" fill="url(#dot-grid)" />

        <g class="graph-viewport" transform=${`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          <!-- Линии связей -->
          <g class="graph-edges-layer">
            ${(simEdgesRef.current || []).map((e, idx) => {
              const u = (simNodesRef.current || []).find((n) => n.id === e.source);
              const v = (simNodesRef.current || []).find((n) => n.id === e.target);
              if (!u || !v || !isNodeVisible(u) || !isNodeVisible(v)) return null;

              const isEdgeActive = highlightFocusId && (e.source === highlightFocusId || e.target === highlightFocusId);
              const isEdgeDimmed = highlightFocusId && !isEdgeActive;
              const isDashed = e.type === "global" || e.type === "implicit";
              const strokeColor = isEdgeActive ? (e.color || "var(--accent)") : (e.color || "var(--border-strong)");

              return html`<line
                key=${idx}
                ref=${(el) => { if (el) edgeElMap.current.set(idx, el); else edgeElMap.current.delete(idx); }}
                data-edge-idx=${idx}
                x1=${Math.round(u.x)} y1=${Math.round(u.y)}
                x2=${Math.round(v.x)} y2=${Math.round(v.y)}
                stroke=${strokeColor}
                stroke-width=${isEdgeActive ? 2.2 : 1.3}
                stroke-dasharray=${isDashed ? "4,4" : "none"}
                opacity=${isEdgeDimmed ? (selectedId ? 0.08 : 0.25) : (isEdgeActive ? 1.0 : (isDashed ? 0.45 : 0.75))} />`;
            })}
          </g>

          <!-- Узлы -->
          <g class="graph-nodes-layer">
            ${(simNodesRef.current || []).map((n) => {
              if (!isNodeVisible(n)) return null;
              const isSelected = selectedId === n.id;
              const isNeighbor = highlightNeighbors && highlightNeighbors.has(n.id);
              const isDimmed = highlightFocusId && !isNeighbor;
              const dimClass = isDimmed ? (selectedId ? "dimmed-strong" : "dimmed-soft") : "";

              return html`<g
                key=${n.id}
                ref=${(el) => { if (el) nodeElMap.current.set(n.id, el); else nodeElMap.current.delete(n.id); }}
                data-node-id=${n.id}
                class=${"graph-node-group " + dimClass + (isSelected ? " selected" : "")}
                transform=${`translate(${Math.round(n.x)}, ${Math.round(n.y)})`}
                onPointerDown=${(e) => onNodePointerDown(e, n)}
                onPointerEnter=${() => setHoveredId(n.id)}
                onPointerLeave=${() => setHoveredId(null)}
                onClick=${(e) => onNodeClick(e, n)}
                onContextMenu=${(e) => onNodeContextMenu(e, n)}>

                ${n.type === "server" ? html`
                  <rect x="-87" y="-27" width="175" height="54" rx="10"
                        class=${"graph-node-rect server " + (n.data.status_kind || "ok")} />
                  <circle cx="-68" cy="0" r="6" class=${"status-dot " + (n.data.status_kind || "ok")} />
                  <text x="-52" y="-4" class="node-title server">${truncateWithEllipsis(n.label, 14)}</text>
                  <text x="-52" y="14" class="node-sub">${n.sub}</text>
                  ${n.data.active_alerts_count > 0 ? html`
                    <circle cx="70" cy="-17" r="9" fill="var(--danger)" />
                    <text x="70" y="-13" class="node-badge-text">${n.data.active_alerts_count}</text>
                  ` : null}
                ` : null}

                ${n.type === "operation" ? (() => {
                  const [l1, l2] = splitLabelTwoLines(n.label, 15);
                  return html`
                    <rect x="-75" y="-21" width="150" height="42" rx="21"
                          style=${n.themeColor ? `stroke: ${n.themeColor}` : ""}
                          class=${"graph-node-rect operation " + (n.data.source === "user" ? "user" : "system")} />
                    ${l2
                      ? html`<text x="0" y="-8" text-anchor="middle" class="node-title">${l1}</text>
                             <text x="0" y="5" text-anchor="middle" class="node-title">${l2}</text>
                             <text x="0" y="15" text-anchor="middle" class="node-sub" style="font-size:8px">
                               ${n.data.source === "user" ? "user" : "system"}${n.data.flags?.streaming ? " · stream" : ""}
                             </text>`
                      : html`<text x="0" y="-3" text-anchor="middle" class="node-title">${l1}</text>
                             <text x="0" y="11" text-anchor="middle" class="node-sub">
                               ${n.data.source === "user" ? "user" : "system"}${n.data.flags?.streaming ? " · stream" : ""}
                             </text>`}
                  `;
                })() : null}

                ${n.type === "alert_rule" ? (() => {
                  const [l1, l2] = splitLabelTwoLines(n.label, 15);
                  const isOff = !n.data.enabled;
                  return html`
                    <rect x="-80" y="-23" width="160" height="46" rx="6"
                          class=${"graph-node-rect rule " + n.data.severity + (isOff ? " rule-disabled" : "")} />
                    <rect x="-80" y="-23" width="5" height="46" rx="2"
                          fill=${n.data.severity === "critical" ? "var(--danger)" : (n.data.severity === "warning" ? "var(--warn)" : "var(--info)")} />
                    ${l2
                      ? html`<text x="-67" y="-9" class="node-title">${l1}</text>
                             <text x="-67" y="4" class="node-title">${l2}</text>
                             <text x="-67" y="16" class="node-sub">${n.sub}</text>`
                      : html`<text x="-67" y="-4" class="node-title">${l1}</text>
                             <text x="-67" y="12" class="node-sub">${n.sub}</text>`}
                    ${isOff ? html`
                      <rect x="52" y="-19" width="22" height="13" rx="3" fill="var(--bg-subtle)" stroke="var(--border)" />
                      <text x="63" y="-10" text-anchor="middle" class="node-policy-text" style="fill:var(--fg-muted)">off</text>
                    ` : null}
                    ${n.data.active_alerts_count > 0 ? html`
                      <circle cx="68" cy="-15" r="9" fill="var(--danger)" />
                      <text x="68" y="-12" class="node-badge-text">${n.data.active_alerts_count}</text>
                    ` : null}
                  `;
                })() : null}

                ${n.type === "reaction_rule" ? (() => {
                  const [l1, l2] = splitLabelTwoLines(n.label, 15);
                  const isOff = !n.data.enabled;
                  return html`
                    <rect x="-80" y="-23" width="160" height="46" rx="6"
                          class=${"graph-node-rect reaction" + (isOff ? " reaction-disabled" : "")} />
                    ${l2
                      ? html`<text x="-71" y="-9" class="node-title">${l1}</text>
                             <text x="-71" y="4" class="node-title">${l2}</text>
                             <text x="-71" y="16" class="node-sub">${n.sub}</text>`
                      : html`<text x="-71" y="-4" class="node-title">${l1}</text>
                             <text x="-71" y="12" class="node-sub">${n.sub}</text>`}
                    <rect x="38" y="-14" width="36" height="15" rx="4"
                          fill=${n.data.action_policy === "auto" ? "color-mix(in oklab, var(--ok) 25%, transparent)" : "color-mix(in oklab, var(--warn) 25%, transparent)"} />
                    <text x="56" y="-3" text-anchor="middle" class="node-policy-text">
                      ${n.data.action_policy}
                    </text>
                  `;
                })() : null}
              </g>`;
            })}
          </g>
        </g>
      </svg>

      <!-- Легенда в правом верхнем углу (скрывается при открытой модалке) -->
      ${!modalState ? html`<div class="graph-legend-wrap" onClick=${(e) => e.stopPropagation()}>
        <button type="button"
                class="btn btn-sm graph-legend-btn"
                onClick=${() => setLegendOpen(!legendOpen)}
                title="Показать / скрыть легенду">
          ⓘ Легенда
        </button>
        ${legendOpen ? html`
          <div class="graph-legend-card card stack">
            <div class="row">
              <b class="small grow">Легенда графа</b>
              <button type="button" class="sym-btn" style="width:22px;height:22px" onClick=${() => setLegendOpen(false)}>×</button>
            </div>
            <div class="stack small" style="gap:4px">
              <div class="row" style="gap:6px"><span class="legend-shape srv"></span><span>Сервер (цвет = статус)</span></div>
              <div class="row" style="gap:6px"><span class="legend-shape op"></span><span>Операция (sys / user)</span></div>
              <div class="row" style="gap:6px"><span class="legend-shape rule"></span><span>Правило алерта (пунктир = off)</span></div>
              <div class="row" style="gap:6px"><span class="legend-shape rx"></span><span>Реакция (внешняя орбита)</span></div>
              <div class="row" style="gap:6px"><span class="legend-line solid"></span><span>Прямая привязка</span></div>
              <div class="row" style="gap:6px"><span class="legend-line dashed"></span><span>Общая / глобальная связь</span></div>
            </div>
            ${allServers.length > 0 ? html`
              <div class="stack small" style="gap:3px; border-top:1px solid var(--border); padding-top:6px">
                <span class="muted">Цвета связей серверов:</span>
                ${allServers.map((s, idx) => html`<div class="row" key=${s.id} style="gap:6px">
                  <span style=${`display:inline-block; width:10px; height:10px; border-radius:50%; background:${getServerColor(idx)}`}></span>
                  <span>${s.name}</span>
                </div>`)}
              </div>
            ` : null}
          </div>
        ` : null}
      </div>` : null}

      <!-- Инспектор выбранного узла -->
      ${inspectorData && selectedId ? html`
        <div class="graph-inspector card stack"
             style=${inspectorData.style}
             onClick=${(e) => e.stopPropagation()}>
          <div class="row" style="align-items:flex-start">
            <div class="grow">
              <span class="badge ${inspectorData.node.type === 'server' ? 'ok' : 'info'}">
                ${inspectorData.node.type === 'server' ? 'Сервер' : (inspectorData.node.type === 'operation' ? 'Операция' : (inspectorData.node.type === 'alert_rule' ? 'Правило алерта' : 'Реакция'))}
              </span>
              <h4 style="margin:4px 0 0; font-size:0.9375rem">${inspectorData.node.label}</h4>
              <div class="muted small mono">${inspectorData.node.sub}</div>
            </div>
            <button type="button" class="sym-btn" style="width:24px;height:24px" onClick=${() => { setSelectedId(null); setInspectorData(null); }}>×</button>
          </div>

          ${inspectorData.node.type === "server" ? html`
            <div class="muted small">
              Статус: <b>${inspectorData.node.data.status_label || (inspectorData.node.data.offline ? "offline" : (inspectorData.node.data.anomaly ? "аномалия" : "ok"))}</b>
              ${inspectorData.node.data.active_alerts_count > 0 ? html`<br />Активных алертов: <b>${inspectorData.node.data.active_alerts_count}</b>` : null}
            </div>
            <button class="btn btn-sm btn-primary" onClick=${() => {
              window.dispatchEvent(new CustomEvent("melecho:open-server", { detail: { id: inspectorData.node.data.id } }));
            }}>Открыть сервер</button>
          ` : null}

          ${inspectorData.node.type === "operation" ? html`
            <div class="muted small">
              Категория: <b>${inspectorData.node.data.category}</b> · Источник: <b>${inspectorData.node.data.source}</b>
              <br />Привязка: <b>${inspectorData.node.data.is_global ? "все серверы" : (inspectorData.node.data.is_unbound ? "не привязана" : `${inspectorData.node.data.server_ids?.length || 0} серверов`)}</b>
            </div>
            ${inspectorData.node.data.source === "user" ? html`
              <button class="btn btn-sm btn-primary" onClick=${() => {
                const clean = inspectorData.node.data.id.startsWith("user:") ? inspectorData.node.data.id.slice(5) : inspectorData.node.data.id;
                openGraphModal({ type: "edit_op", oid: clean });
              }}>Правка операции</button>
            ` : null}
          ` : null}

          ${inspectorData.node.type === "alert_rule" ? html`
            <div class="muted small">
              Важность: <b>${inspectorData.node.data.severity}</b> · Включено: <b>${inspectorData.node.data.enabled ? "да" : "нет"}</b>
              ${inspectorData.node.data.active_alerts_count > 0 ? html`<br />Активных алертов: <b>${inspectorData.node.data.active_alerts_count}</b>` : null}
            </div>
            <div class="row">
              <button class="btn btn-sm btn-primary" onClick=${() => openGraphModal({ type: "view_rule", id: inspectorData.node.data.id })}>
                Подробнее
              </button>
              <button class="btn btn-sm btn-ghost" onClick=${() => openGraphModal({ type: "edit_rule", id: inspectorData.node.data.id, initial: alertRuleToEditorInitial(inspectorData.node.data) })}>
                Правка
              </button>
            </div>
          ` : null}

          ${inspectorData.node.type === "reaction_rule" ? html`
            <div class="muted small">
              Политика: <b>${inspectorData.node.data.action_policy}</b> · Sudo: <b>${inspectorData.node.data.sudo_mode}</b>
              <br />Статистика: ✅ ${inspectorData.node.data.stats?.ok || 0} · ❌ ${inspectorData.node.data.stats?.fail || 0}
            </div>
            <button class="btn btn-sm btn-primary" onClick=${() => openGraphModal({ type: "edit_rx", id: inspectorData.node.data.id })}>
              Правка реакции
            </button>
          ` : null}
        </div>
      ` : null}

      <!-- Контекстное меню ПКМ -->
      ${contextMenu ? html`
        <div class="graph-context-menu"
             style=${`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
             onClick=${(e) => e.stopPropagation()}
             onContextMenu=${(e) => e.preventDefault()}>
          ${contextMenu.items.map((it, idx) => {
            if (it.sep) return html`<div class="menu-sep" key=${idx}></div>`;
            return html`<button type="button" class="menu-item" key=${idx} onClick=${() => {
              setContextMenu(null);
              it.action && it.action();
            }}>${it.label}</button>`;
          })}
        </div>
      ` : null}
    </div>

    <!-- Модалки создания / редактирования сущностей с графа -->
    ${modalState?.type === "new_op" ? html`
      <${UserOpEditor}
        mode="create"
        onClose=${() => setModalState(null)}
        onSaved=${async () => { setModalState(null); await loadGraph(); onRefreshStatus && onRefreshStatus(); }} />
    ` : null}

    ${modalState?.type === "edit_op" ? html`
      <${UserOpEditor}
        mode="edit"
        oid=${modalState.oid}
        onClose=${() => setModalState(null)}
        onSaved=${async () => { setModalState(null); await loadGraph(); onRefreshStatus && onRefreshStatus(); }} />
    ` : null}

    ${modalState?.type === "new_rule" ? html`
      <${AlertRuleEditor}
        onSubmit=${async (body) => {
          await api("/api/v1/alert-rules", { method: "POST", body: JSON.stringify(body) });
          setModalState(null);
          await loadGraph();
          onRefreshStatus && onRefreshStatus();
        }}
        onClose=${() => setModalState(null)} />
    ` : null}

    ${modalState?.type === "view_rule" ? html`
      <${AlertRuleDetailModal}
        rid=${modalState.id}
        onClose=${() => setModalState(null)}
        onEdit=${(r) => setModalState({ type: "edit_rule", id: r.id, initial: alertRuleToEditorInitial(r) })}
        onReloadList=${loadGraph} />
    ` : null}

    ${modalState?.type === "edit_rule" ? html`
      <${AlertRuleEditor}
        initial=${modalState.initial}
        onSubmit=${async (body) => {
          await api("/api/v1/alert-rules/" + modalState.id, { method: "PATCH", body: JSON.stringify(body) });
          setModalState(null);
          await loadGraph();
          onRefreshStatus && onRefreshStatus();
        }}
        onClose=${() => setModalState(null)} />
    ` : null}

    ${modalState?.type === "new_rx" ? html`
      <${ReactionRuleEditor}
        onClose=${() => setModalState(null)}
        onSaved=${async () => { setModalState(null); await loadGraph(); onRefreshStatus && onRefreshStatus(); }} />
    ` : null}

    ${modalState?.type === "edit_rx" ? html`
      <${ReactionRuleEditor}
        initial=${reactionRuleToEditorInitial((data?.reaction_rules || []).find((x) => x.id === modalState.id))}
        onClose=${() => setModalState(null)}
        onSaved=${async () => { setModalState(null); await loadGraph(); onRefreshStatus && onRefreshStatus(); }} />
    ` : null}
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
      <button class=${sub === "graph" ? "on" : ""} onClick=${() => setSub("graph")}>Граф</button>
    </div>
    ${sub === "reactions" ? html`<${ReactionsView} />` : null}
    ${sub === "operations" ? html`<${UserOpsView} />` : null}
    ${sub === "alert_rules" ? html`<${AlertRulesView}
        initialDetailRid=${initialRuleRid}
        onDetailClosed=${onRuleDetailClosed} />` : null}
    ${sub === "graph" ? html`<div class="stack" style="height: calc(100vh - 210px); min-height: 480px;">
        <${AutomationGraphView} onRefreshStatus=${onRefreshStatus} />
      </div>` : null}
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
  const [ctxDraft, setCtxDraft] = useState({ max_messages: 20, max_chars: 32000, cross_mode: true });
  const [ctxBusy, setCtxBusy] = useState(false);
  const [detDraft, setDetDraft] = useState({
    z_threshold: 3.0,
    ignore_drops: true,
    abs_cpu: 90,
    abs_ram: 90,
    abs_disk: 90,
    abs_load_1m_per_cpu: 1.5,
  });
  const [detBusy, setDetBusy] = useState(false);
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

  useEffect(() => {
    if (!s) return;
    setCtxDraft({
      max_messages: s.llm_context_max_messages ?? 20,
      max_chars: s.llm_context_max_chars ?? 32000,
      cross_mode: s.llm_context_cross_mode !== false,
    });
    setDetDraft({
      z_threshold: Number(s.detector_z_threshold) || 3.0,
      ignore_drops: s.detector_ignore_drops !== false,
      abs_cpu: Number(s.detector_abs_cpu) || 90,
      abs_ram: Number(s.detector_abs_ram) || 90,
      abs_disk: Number(s.detector_abs_disk) || 90,
      abs_load_1m_per_cpu: Number(s.detector_abs_load_1m_per_cpu) || 1.5,
    });
  }, [
    s && s.llm_context_max_messages, s && s.llm_context_max_chars, s && s.llm_context_cross_mode,
    s && s.detector_z_threshold, s && s.detector_ignore_drops, s && s.detector_abs_cpu,
    s && s.detector_abs_ram, s && s.detector_abs_disk, s && s.detector_abs_load_1m_per_cpu
  ]);

  async function saveDetectorSettings(patch) {
    setDetBusy(true);
    try {
      const payload = patch || {
        detector_z_threshold: Number(detDraft.z_threshold) || 3.0,
        detector_ignore_drops: !!detDraft.ignore_drops,
        detector_abs_cpu: Number(detDraft.abs_cpu) || 90,
        detector_abs_ram: Number(detDraft.abs_ram) || 90,
        detector_abs_disk: Number(detDraft.abs_disk) || 90,
        detector_abs_load_1m_per_cpu: Number(detDraft.abs_load_1m_per_cpu) || 1.5,
      };
      const r = await api("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setS(r);
      showToast("Настройки детектора аномалий сохранены", "ok");
    } catch (ex) {
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setDetBusy(false);
    }
  }

  async function saveCtx(override) {
    setCtxBusy(true);
    try {
      const payload = override || {
        llm_context_max_messages: Math.max(0, Number(ctxDraft.max_messages) || 0),
        llm_context_max_chars: Math.max(0, Number(ctxDraft.max_chars) || 0),
        llm_context_cross_mode: !!ctxDraft.cross_mode,
      };
      const r = await api("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setS(r);
      window.dispatchEvent(new Event("melecho:refresh-llm-profiles"));
      showToast("Настройки контекста сохранены", "ok");
    } catch (ex) {
      showToast("Ошибка: " + ex.message, "error");
    } finally {
      setCtxBusy(false);
    }
  }

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

    <div class="card stack">
      <h3>Контекст LLM</h3>
      <p class="muted">
        Управление историей диалога, передаваемой модели. Значение <span class="mono">0</span> отключает ограничение.
      </p>
      <label class="check check--onoff">
        <input type="checkbox" checked=${!!ctxDraft.cross_mode}
               disabled=${ctxBusy}
               onChange=${(e) => {
                 const next = e.target.checked;
                 setCtxDraft({ ...ctxDraft, cross_mode: next });
                 saveCtx({ llm_context_cross_mode: next });
               }} />
        <span>${ctxDraft.cross_mode ? "сквозной контекст между режимами (chat, /alert, /operation, /reaction)" : "режимы изолированы друг от друга"}</span>
      </label>
      <div class="row" style="align-items: flex-end;">
        <div style="flex: 1; min-width: 140px;">
          <label>Макс. сообщений ${Number(ctxDraft.max_messages) === 0 ? "(без ограничений)" : ""}</label>
          <input type="number" min="0" max="500"
                 value=${ctxDraft.max_messages}
                 disabled=${ctxBusy}
                 onInput=${(e) => setCtxDraft({ ...ctxDraft, max_messages: e.target.value })} />
        </div>
        <div style="flex: 1; min-width: 160px;">
          <label>Макс. символов ${Number(ctxDraft.max_chars) === 0 ? "(без ограничений)" : ""}</label>
          <input type="number" min="0" max="500000" step="1000"
                 value=${ctxDraft.max_chars}
                 disabled=${ctxBusy}
                 onInput=${(e) => setCtxDraft({ ...ctxDraft, max_chars: e.target.value })} />
        </div>
        <button type="button" class="btn btn-sm btn-ghost"
                disabled=${ctxBusy}
                title="Установить 0 для обоих лимитов"
                onClick=${() => {
                  const unlim = { ...ctxDraft, max_messages: 0, max_chars: 0 };
                  setCtxDraft(unlim);
                  saveCtx({ llm_context_max_messages: 0, llm_context_max_chars: 0 });
                }}>
          Снять ограничения
        </button>
        <button type="button" class="btn btn-sm btn-primary"
                disabled=${ctxBusy}
                onClick=${() => saveCtx()}>
          ${ctxBusy ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
    </div>

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

    <div class="card stack">
      <h3>Детектор аномалий</h3>
      <p class="muted">
        Статистическая детекция отклонений от нормы по скользящему экспоненциальному среднему (EWMA + Z-score) и абсолютные пороги.
      </p>

      <div class="form-sub">
        <label>Чувствительность к аномалиям (Z-score порог)</label>
        <div class="preset-pills">
          ${[
            [2.5, "Высокая 2.5σ"],
            [3.0, "Стандартная 3.0σ"],
            [4.5, "Умеренная 4.5σ"],
            [6.0, "Низкая 6.0σ"],
          ].map(([val, lbl]) => html`<button type="button" key=${val}
              class=${"preset-pill" + (Math.abs(detDraft.z_threshold - val) < 0.05 ? " on" : "")}
              disabled=${detBusy}
              onClick=${() => {
                const next = { ...detDraft, z_threshold: val };
                setDetDraft(next);
                saveDetectorSettings({ detector_z_threshold: val });
              }}>${lbl}</button>`)}
        </div>
        <div class="row" style="align-items:center; gap:8px; margin-top:4px">
          <input type="number" step="0.1" min="1.0" max="20.0" style="max-width:160px"
                 value=${detDraft.z_threshold}
                 disabled=${detBusy}
                 onInput=${(e) => setDetDraft({ ...detDraft, z_threshold: e.target.value })} />
          <span class="muted small">σ (стандартных отклонений от baseline)</span>
        </div>
      </div>

      <label class="check check--onoff" style="margin-top:6px">
        <input type="checkbox" checked=${!!detDraft.ignore_drops}
               disabled=${detBusy}
               onChange=${(e) => {
                 const next = e.target.checked;
                 setDetDraft({ ...detDraft, ignore_drops: next });
                 saveDetectorSettings({ detector_ignore_drops: next });
               }} />
        <span>Игнорировать падения метрик (аномалией считается только рост нагрузки)</span>
      </label>

      <div class="form-sub" style="margin-top:8px">
        <label>Абсолютные пороги срабатывания (OR с Z-score)</label>
        <div class="row" style="flex-wrap:wrap; gap:12px">
          <div style="flex:1; min-width:120px">
            <label>CPU, %</label>
            <input type="number" min="1" max="100" value=${detDraft.abs_cpu}
                   disabled=${detBusy}
                   onInput=${(e) => setDetDraft({ ...detDraft, abs_cpu: e.target.value })} />
          </div>
          <div style="flex:1; min-width:120px">
            <label>RAM, %</label>
            <input type="number" min="1" max="100" value=${detDraft.abs_ram}
                   disabled=${detBusy}
                   onInput=${(e) => setDetDraft({ ...detDraft, abs_ram: e.target.value })} />
          </div>
          <div style="flex:1; min-width:120px">
            <label>Диск, %</label>
            <input type="number" min="1" max="100" value=${detDraft.abs_disk}
                   disabled=${detBusy}
                   onInput=${(e) => setDetDraft({ ...detDraft, abs_disk: e.target.value })} />
          </div>
          <div style="flex:1; min-width:140px">
            <label>Load 1m на ядро</label>
            <input type="number" step="0.1" min="0.1" max="50" value=${detDraft.abs_load_1m_per_cpu}
                   disabled=${detBusy}
                   onInput=${(e) => setDetDraft({ ...detDraft, abs_load_1m_per_cpu: e.target.value })} />
          </div>
        </div>
      </div>

      <div class="row" style="margin-top:4px">
        <button type="button" class="btn btn-sm btn-primary"
                disabled=${detBusy}
                onClick=${() => saveDetectorSettings()}>
          ${detBusy ? "Сохранение…" : "Сохранить настройки детектора"}
        </button>
      </div>
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
        throw new Error("укажите хотя бы один порог (от или до)");
      }
      return out;
    }
    if (kind === "metric_stale") {
      const sec = Number(cond.no_data_sec);
      if (!Number.isFinite(sec) || sec <= 0) throw new Error("время отсутствия данных: положительное число");
      return { no_data_sec: sec };
    }
    if (kind === "manual_op_failed") {
      const v = Number(cond.exit_ne ?? 0);
      if (!Number.isFinite(v)) throw new Error("ожидаемый код выхода: число");
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
        throw new Error("интервал проверки: 60..86400 сек");
      }
      body.interval_sec = iv;
      const s = editing.servers || { all: true };
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
  const currentOpId = (cond.operation_id || "").trim();
  const selectedOp = ops.find((o) => o.id === currentOpId) || null;
  const opInList = !!selectedOp;
  const serversState = editing.servers || { all: true };
  const serversAll = !!serversState.all;
  const serversIds = serversAll ? [] : (serversState.ids || []);

  // Удобный разбор expected для operation_check
  let expObj = {};
  let expJsonErr = false;
  if (kindIsOp) {
    try {
      const parsed = JSON.parse(cond.expected_str || '{"exit": 0}');
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) expObj = parsed;
      else expJsonErr = true;
    } catch { expJsonErr = true; }
  }
  function updateExpected(patch) {
    const next = { ...expObj, ...patch };
    if (next.exit === "" || next.exit == null) delete next.exit;
    else next.exit = Number(next.exit);
    if (!next.stdout_regex) delete next.stdout_regex;
    setCond({ expected_str: JSON.stringify(next, null, 2) });
  }

  // Удобный разбор auto_resolve_json ({"below": N}) для metric_threshold
  let arObj = null;
  let arJsonErr = false;
  if (editing.auto_resolve_json_str && editing.auto_resolve_json_str.trim()) {
    try {
      const parsed = JSON.parse(editing.auto_resolve_json_str);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) arObj = parsed;
      else arJsonErr = true;
    } catch { arJsonErr = true; }
  }
  const thresholdOpKey = ["value_gte", "value_gt", "value_lte", "value_lt"].find((k) => cond[k] != null) || "value_gte";
  const thresholdVal = cond[thresholdOpKey] ?? 90;

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
    <input placeholder="например: Высокая загрузка CPU"
           value=${editing.name}
           onInput=${(e) => setEditing({ ...editing, name: e.target.value })} />

    <div class="form-section">
      <div class="form-section-title">
        Что отслеживаем
        <${InfoHint} text="Тип условия определяет механизм проверки. Менять его у уже созданного правила нельзя." />
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
        ? html`<span class="muted small">тип условия зафиксирован при создании</span>`
        : null}
    </div>

    <div class="form-section">
      <div class="form-section-title">Условие срабатывания</div>

      ${kind === "metric_threshold" ? html`
        <div class="row">
          <div style="flex:1">
            <label>Метрика</label>
            <select value=${cond.metric || "cpu"}
                    onChange=${(e) => setCond({ metric: e.target.value })}>
              <option value="cpu">CPU (%)</option>
              <option value="ram">RAM (%)</option>
              <option value="disk">Диск (%)</option>
              <option value="load_1m">Load 1m (на 1 ядро)</option>
            </select>
          </div>
          <div style="flex:1">
            <label>Условие</label>
            <select value=${thresholdOpKey}
                    onChange=${(e) => {
                      const prevVal = thresholdVal;
                      const next = { ...cond };
                      for (const k of ["value_gte","value_gt","value_lte","value_lt"]) delete next[k];
                      next[e.target.value] = prevVal;
                      setEditing({ ...editing, cond: next });
                    }}>
              <option value="value_gte"><span class="op-sym">≥</span> (не ниже)</option>
              <option value="value_gt"><span class="op-sym">${">"}</span> (строго выше)</option>
              <option value="value_lte"><span class="op-sym">≤</span> (не выше)</option>
              <option value="value_lt"><span class="op-sym">${"<"}</span> (строго ниже)</option>
            </select>
          </div>
          <div style="flex:1">
            <label>Порог</label>
            <input type="number" step="any" value=${thresholdVal}
                   onInput=${(e) => setCond({ [thresholdOpKey]: e.target.value })} />
          </div>
        </div>
        ${(cond.metric || "cpu") === "load_1m"
          ? html`<span class="muted small">
              Значение задаётся на 1 ядро CPU: реальный порог = <span class="mono">nproc × значение</span>.
            </span>`
          : null}
      ` : null}

      ${kindIsOp ? html`
        <div class="form-sub">
          <label>Операция для проверки</label>
          <select value=${currentOpId}
                  onChange=${(e) => setCond({ operation_id: e.target.value, params_str: "{}" })}>
            <option value="">— выбрать операцию —</option>
            ${ops.map((o) => html`<option value=${o.id} key=${o.id}>${o.name} (${o.id})</option>`)}
            ${currentOpId && !opInList
              ? html`<option value=${currentOpId}>${currentOpId} (операция удалена)</option>`
              : null}
          </select>
        </div>
        <${OperationParamsFields}
          op=${selectedOp}
          paramsStr=${cond.params_str || "{}"}
          onChangeStr=${(v) => setCond({ params_str: v })}
          servers=${servers} />
        <div class="form-sub">
          <label>
            Критерий успеха (иначе создаётся алерт)
            <${InfoHint} text="Проверка считается пройденной (ok), если код возврата и вывод совпадают с ожидаемыми." />
          </label>
          ${expJsonErr
            ? html`<textarea class="mono llm-rule-cond" rows="3" value=${cond.expected_str || '{"exit": 0}'}
                        onInput=${(e) => setCond({ expected_str: e.target.value })}></textarea>`
            : html`<div class="row">
                <div style="flex:0 0 140px">
                  <label>Ожидаемый exit-код</label>
                  <input type="number" value=${expObj.exit ?? 0}
                         onInput=${(e) => updateExpected({ exit: e.target.value })} />
                </div>
                <div class="grow">
                  <label>Regex в stdout (опционально)</label>
                  <input class="mono" placeholder="например active"
                         value=${expObj.stdout_regex || ""}
                         onInput=${(e) => updateExpected({ stdout_regex: e.target.value })} />
                </div>
              </div>
              <details>
                <summary class="muted small">Критерий успеха как JSON</summary>
                <textarea class="mono llm-rule-cond" rows="3" style="margin-top:6px"
                          value=${cond.expected_str || '{\n  "exit": 0\n}'}
                          onInput=${(e) => setCond({ expected_str: e.target.value })}></textarea>
              </details>`}
        </div>
        <div class="row">
          <div style="flex:0 0 160px">
            <label>Интервал запуска, сек</label>
            <input type="number" min="60" max="86400"
                   value=${editing.interval_sec}
                   onInput=${(e) => setEditing({ ...editing, interval_sec: Number(e.target.value) })} />
          </div>
          <span class="muted small" style="align-self:flex-end; padding-bottom:10px">
            ${fmtSecHint(editing.interval_sec)} (допустимо 60..86400 сек)
          </span>
        </div>
        <div class="form-sub">
          <label>На каких серверах запускать</label>
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
            <label>Отклонение от (z_min, σ)</label>
            <input type="number" step="0.1" value=${cond.z_min ?? ""}
                   onInput=${(e) => setCond({ z_min: e.target.value })} />
          </div>
          <div style="flex:1">
            <label>До (z_max, опционально)</label>
            <input type="number" step="0.1" value=${cond.z_max ?? ""}
                   onInput=${(e) => setCond({ z_max: e.target.value })} />
          </div>
        </div>
        <span class="muted small">
          Срабатывает при |z| ≥ z_min. Обычно warning: 3.0..4.5, critical: ≥ 4.5.
        </span>
      ` : null}

      ${kind === "metric_stale" ? html`
        <label>Нет метрик дольше, сек</label>
        <div class="row">
          <input type="number" min="30" style="max-width:180px"
                 value=${cond.no_data_sec || 300}
                 onInput=${(e) => setCond({ no_data_sec: e.target.value })} />
          <span class="muted small">${fmtSecHint(cond.no_data_sec || 300)} (300 с = 5 мин, 1800 с = 30 мин)</span>
        </div>
      ` : null}

      ${kind === "manual_op_failed" ? html`
        <label>Считать ошибкой, если код выхода не равен</label>
        <input type="number" style="max-width:180px" value=${cond.exit_ne ?? 0}
               onInput=${(e) => setCond({ exit_ne: e.target.value })} />
        <span class="muted small">По умолчанию 0: алерт при любом ненулевом exit-коде ручной операции.</span>
      ` : null}

      ${kind === "reaction_failed" ? html`
        <label>При каких статусах реакции создавать алерт</label>
        <${MultiSelect}
          options=${[
            { value: "failed", label: "failed (ошибка)" },
            { value: "timeout", label: "timeout (таймаут)" },
          ]}
          selected=${Array.isArray(cond.status_in) ? cond.status_in : []}
          onChange=${(s) => setCond({ status_in: s })}
          placeholder="выбрать статусы" />
      ` : null}
    </div>

    <div class="form-section">
      <div class="form-section-title">Параметры алерта</div>

      <div class="row">
        <div style="flex:1">
          <label>Важность (Severity)</label>
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
              <label>Область (Сервер)</label>
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
        <div style="flex:0 0 150px">
          <label>
            Пауза (Cooldown), сек
            <${InfoHint} text="Как часто можно повторять/эмитить события по этому правилу." />
          </label>
          <input type="number" min="0" max="86400" value=${editing.cooldown_sec}
                 onInput=${(e) => setEditing({ ...editing, cooldown_sec: Number(e.target.value) })} />
          <div class="muted small">${fmtSecHint(editing.cooldown_sec)}</div>
        </div>
      </div>

      ${kind === "metric_threshold"
        ? html`<div class="form-sub">
            <label class="check">
              <input type="checkbox"
                     checked=${!arJsonErr && arObj != null && arObj.below != null}
                     onChange=${(e) => {
                       if (e.target.checked) {
                         const defVal = Number(thresholdVal) || 90;
                         setEditing({ ...editing, auto_resolve_json_str: JSON.stringify({ below: defVal }) });
                       } else {
                         setEditing({ ...editing, auto_resolve_json_str: "" });
                       }
                     }} />
              <span>Закрывать алерт автоматически, когда значение вернётся в норму</span>
            </label>
            ${!arJsonErr && arObj != null && arObj.below != null
              ? html`<div class="row">
                  <span class="muted small">Закрывать, если значение ниже:</span>
                  <input type="number" step="any" style="max-width:120px; height:34px"
                         value=${arObj.below}
                         onInput=${(e) => {
                           const v = e.target.value;
                           const next = { ...arObj, below: v === "" ? "" : Number(v) };
                           setEditing({ ...editing, auto_resolve_json_str: JSON.stringify(next) });
                         }} />
                </div>`
              : null}
            <details>
              <summary class="muted small">Auto-resolve как JSON</summary>
              <textarea class="mono llm-rule-cond" rows="2" style="margin-top:6px"
                        placeholder='{"below": 90}'
                        value=${editing.auto_resolve_json_str}
                        onInput=${(e) => setEditing({ ...editing, auto_resolve_json_str: e.target.value })}></textarea>
            </details>
          </div>`
        : (kind === "metric_zscore" || kind === "metric_stale")
        ? html`<details>
            <summary class="muted small">Дополнительно: auto-resolve JSON (для встроенных правил работает автоматически)</summary>
            <textarea class="mono llm-rule-cond" rows="2" style="margin-top:6px"
                      placeholder='{"below": 90}'
                      value=${editing.auto_resolve_json_str}
                      onInput=${(e) => setEditing({ ...editing, auto_resolve_json_str: e.target.value })}></textarea>
          </details>`
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
    const onOpenServerFromEv = (ev) => {
      const sidVal = ev && ev.detail && ev.detail.id;
      if (typeof sidVal === "number" && sidVal > 0) {
        setView("dash");
        setSid(sidVal);
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
    window.addEventListener("melecho:open-server", onOpenServerFromEv);
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
    window.removeEventListener("melecho:open-server", onOpenServerFromEv);
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
    ${sid ? html`<${ServerView} id=${sid} llmEnabled=${!!status?.llm_enabled} internetOffline=${!!status?.internet_offline} onBack=${() => setSid(null)} />` : null}
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
