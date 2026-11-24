from __future__ import annotations

import ast
import csv
import io
import json
from collections.abc import Callable
import logging
import math
import operator as _op
import re
from pathlib import Path

import yaml

from melecho.catalog import ID_RE
from melecho.errors import AppError

log = logging.getLogger("melecho")

DISPLAY_MODES = ("display_only", "display_and_raw", "raw_only")

_AST_BIN_OPS: dict[type[ast.operator], Callable[[float, float], float]] = {
    ast.Add: _op.add,
    ast.Sub: _op.sub,
    ast.Mult: _op.mul,
    ast.Div: _op.truediv,
}
_AST_UNARY_OPS: dict[type[ast.unaryop], Callable[[float], float]] = {
    ast.UAdd: _op.pos,
    ast.USub: _op.neg,
}


def eval_display_expr(expr: str, row: dict) -> float | None:
    """Безопасное вычисление арифметических формул из display.columns[].expr без eval()."""
    if not isinstance(expr, str) or not expr.strip():
        return None
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        return None

    def _eval(node) -> float | None:
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return float(node.value)
        if isinstance(node, ast.Name):
            raw = row.get(node.id)
            if raw is None or isinstance(raw, bool):
                return None
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None
        if isinstance(node, ast.UnaryOp) and type(node.op) in _AST_UNARY_OPS:
            v = _eval(node.operand)
            return None if v is None else _AST_UNARY_OPS[type(node.op)](v)
        if isinstance(node, ast.BinOp) and type(node.op) in _AST_BIN_OPS:
            left = _eval(node.left)
            right = _eval(node.right)
            if left is None or right is None:
                return None
            if isinstance(node.op, ast.Div) and right == 0:
                return 0.0
            return _AST_BIN_OPS[type(node.op)](left, right)
        return None

    res = _eval(tree)
    if res is None:
        return None
    if not math.isfinite(res):
        return None
    return res


def _compile_rx(pat: str | None) -> re.Pattern | None:
    if not isinstance(pat, str) or not pat:
        return None
    py_pat = re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", pat)
    try:
        return re.compile(py_pat, re.MULTILINE)
    except re.error:
        return None


def _get_json_path(obj, path: str | None):
    if obj is None:
        return None
    if not path:
        return obj
    cur = obj
    for part in str(path).split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _fmt_bytes(n) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "—"
    if not math.isfinite(v):
        return "—"
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024.0
        i += 1
    digits = 1 if (i > 0 and v < 10) else 0
    return f"{v:.{digits}f} {units[i]}"


def _fmt_cell(val, fmt: str | None) -> str:
    if val is None or val == "":
        return "—"
    if fmt == "bytes":
        return _fmt_bytes(val)
    if fmt == "percent":
        try:
            return f"{float(val):.1f}%"
        except (TypeError, ValueError):
            return "—"
    if fmt == "number":
        try:
            f = float(val)
            return str(int(f)) if f.is_integer() else str(round(f, 2))
        except (TypeError, ValueError):
            return str(val)
    return str(val)


def _eval_single_display(spec: dict, stdout: str) -> dict | None:
    if not isinstance(spec, dict):
        return None
    dtype = spec.get("type")
    text = str(stdout or "")
    title = spec.get("title")
    empty_text = spec.get("empty_text")

    if dtype == "lines":
        lines = text.splitlines()
        inc_rx = [r for r in (_compile_rx(p) for p in (spec.get("include") or [])) if r is not None]
        exc_rx = [r for r in (_compile_rx(p) for p in (spec.get("exclude") or [])) if r is not None]
        matched = []
        for ln in lines:
            if not ln.strip() and inc_rx:
                continue
            if inc_rx and not any(r.search(ln) for r in inc_rx):
                continue
            if exc_rx and any(r.search(ln) for r in exc_rx):
                continue
            matched.append(ln)
        return {"type": "lines", "title": title, "lines": matched, "empty_text": empty_text}

    if dtype == "kv":
        fmt = spec.get("format") or "regex"
        items = []
        if fmt == "json":
            try:
                parsed = json.loads(text)
            except Exception:
                return {"type": "kv", "title": title, "items": [], "error": "Не удалось разобрать JSON"}
            if not isinstance(parsed, dict):
                return {"type": "kv", "title": title, "items": [], "error": "JSON не является объектом"}
            for f in (spec.get("fields") or []):
                val = _get_json_path(parsed, f.get("key"))
                items.append({"label": f.get("label") or f.get("key"), "value": _fmt_cell(val, f.get("format"))})
        else:
            for f in (spec.get("fields") or []):
                rx = _compile_rx(f.get("regex"))
                if rx is None:
                    continue
                m = rx.search(text)
                if m:
                    grp = int(f["group"]) if f.get("group") is not None else (1 if rx.groups >= 1 else 0)
                    try:
                        raw_val = m.group(grp)
                    except IndexError:
                        raw_val = None
                    if raw_val is not None:
                        items.append({
                            "label": f.get("label") or "Поле",
                            "value": _fmt_cell(raw_val.strip(), f.get("format")),
                        })
        return {"type": "kv", "title": title, "items": items, "empty_text": empty_text}

    if dtype == "table":
        fmt = spec.get("format") or "json"
        cols = spec.get("columns") or []
        all_rows: list[dict] = []
        if fmt == "json":
            try:
                data = json.loads(text)
            except Exception:
                return {"type": "table", "title": title, "columns": cols, "rows": [], "error": "Не удалось разобрать JSON"}
            root_arr = _get_json_path(data, spec.get("items_path")) if spec.get("items_path") else data
            if not isinstance(root_arr, list):
                return {"type": "table", "title": title, "columns": cols, "rows": [], "error": "В JSON не найден массив данных"}

            def _walk(arr):
                ckey = spec.get("children_key")
                for item in (arr or []):
                    if not isinstance(item, dict):
                        continue
                    all_rows.append(item)
                    if ckey and isinstance(item.get(ckey), list):
                        _walk(item[ckey])

            _walk(root_arr)
        else:
            rx = _compile_rx(spec.get("regex"))
            if rx is None:
                return {"type": "table", "title": title, "columns": cols, "rows": [], "error": "Некорректный regex"}
            skip = max(0, int(spec.get("skip_lines") or 0))
            for ln in text.splitlines()[skip:]:
                if not ln.strip():
                    continue
                m = rx.search(ln)
                if not m:
                    continue
                gd = m.groupdict()
                if gd:
                    all_rows.append({k: (v.strip() if v is not None else "") for k, v in gd.items()})
                else:
                    row_obj = {}
                    for idx, c in enumerate(cols):
                        try:
                            row_obj[c["key"]] = (m.group(idx + 1) or "").strip()
                        except IndexError:
                            row_obj[c["key"]] = ""
                    all_rows.append(row_obj)

        enriched: list[dict] = []
        for raw_r in all_rows:
            r = dict(raw_r)
            for c in cols:
                if c.get("expr"):
                    r[c["key"]] = eval_display_expr(c["expr"], r)
            enriched.append(r)

        filter_in = spec.get("filter_in")
        main_rows = enriched
        other_rows: list[dict] = []
        if isinstance(filter_in, dict) and filter_in:
            main_rows = []
            for r in enriched:
                ok = all(
                    isinstance(allowed, list) and str(r.get(k) if r.get(k) is not None else "") in allowed
                    for k, allowed in filter_in.items()
                )
                if ok:
                    main_rows.append(r)
                else:
                    other_rows.append(r)

        def _fmt_rows(src_rows: list[dict]) -> list[dict]:
            out_r = []
            for r in src_rows:
                item = {}
                for c in cols:
                    item[c["key"]] = _fmt_cell(r.get(c["key"]), c.get("format"))
                out_r.append(item)
            return out_r

        return {
            "type": "table",
            "title": title,
            "columns": [{"key": c["key"], "label": c.get("label") or c["key"]} for c in cols],
            "rows": _fmt_rows(main_rows),
            "other_summary": spec.get("other_summary"),
            "other_count": len(other_rows),
            "empty_text": empty_text,
        }

    return None


def evaluate_display(display_spec: dict | None, steps: list[dict] | None, stdout: str = "") -> dict | None:
    """Вычисляет структурированный результат display: для экспорта (MD/CSV/JSON)."""
    if not isinstance(display_spec, dict):
        return None
    run_steps = [st for st in (steps or []) if st.get("phase") == "run"]

    def _pick(step_idx) -> str:
        if run_steps:
            if step_idx is not None:
                idx = int(step_idx)
                if -len(run_steps) <= idx < len(run_steps):
                    return str(run_steps[idx].get("stdout") or "")
            return str(run_steps[-1].get("stdout") or "")
        return str(stdout or "")

    if display_spec.get("type") == "sections":
        secs = []
        for sec in (display_spec.get("sections") or []):
            ev = _eval_single_display(sec, _pick(sec.get("step")))
            if ev is not None:
                secs.append(ev)
        return {"type": "sections", "title": display_spec.get("title"), "sections": secs}

    return _eval_single_display(display_spec, _pick(display_spec.get("step")))


def parse_report_dict(raw: dict, *, require_id: bool = True) -> dict:
    """Базовая структурная нормализация и проверка спецификации отчёта."""
    if not isinstance(raw, dict):
        raise ValueError("описание отчёта должно быть YAML/JSON-объектом")
    rid = raw.get("id")
    if require_id:
        if not isinstance(rid, str) or not ID_RE.match(rid):
            raise ValueError("id: обязателен, ^[a-z][a-z0-9_]{0,63}$")
    elif rid is not None:
        if not isinstance(rid, str) or not ID_RE.match(rid):
            raise ValueError("id: ожидается ^[a-z][a-z0-9_]{0,63}$")

    name = str(raw.get("name") or rid or "").strip()
    if not name or len(name) > 200:
        raise ValueError("name: от 1 до 200 символов")
    desc = str(raw.get("description") or "").strip()
    if len(desc) > 500:
        raise ValueError("description: максимум 500 символов")

    parallel = bool(raw.get("parallel_servers", True))
    dmode = str(raw.get("display_mode") or "display_and_raw").strip()
    if dmode not in DISPLAY_MODES:
        raise ValueError(f"display_mode: ожидается {' | '.join(DISPLAY_MODES)}")

    targets_raw = raw.get("targets")
    if not isinstance(targets_raw, list) or not (1 <= len(targets_raw) <= 50):
        raise ValueError("targets: нужен список из 1..50 серверов")

    targets: list[dict] = []
    for idx, t in enumerate(targets_raw):
        if not isinstance(t, dict):
            raise ValueError(f"targets[{idx}]: должен быть объектом")
        srv = t.get("server")
        if srv is None:
            srv = t.get("server_id")
        if isinstance(srv, bool) or srv is None or (isinstance(srv, str) and not srv.strip()):
            raise ValueError(f"targets[{idx}].server: укажите id, llm_alias или 'all'")
        if isinstance(srv, str):
            srv = srv.strip()

        steps_raw = t.get("steps")
        if not isinstance(steps_raw, list) or not (1 <= len(steps_raw) <= 30):
            raise ValueError(f"targets[{idx}].steps: нужен список из 1..30 операций")
        steps: list[dict] = []
        for s_idx, st in enumerate(steps_raw):
            if not isinstance(st, dict):
                raise ValueError(f"targets[{idx}].steps[{s_idx}]: должен быть объектом")
            oid = str(st.get("operation_id") or "").strip()
            if not oid:
                raise ValueError(f"targets[{idx}].steps[{s_idx}].operation_id: обязателен")
            params = st.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError(f"targets[{idx}].steps[{s_idx}].params: должен быть объектом")
            use_sudo = st.get("use_sudo")
            if use_sudo is not None and not isinstance(use_sudo, bool):
                raise ValueError(f"targets[{idx}].steps[{s_idx}].use_sudo: true|false")
            steps.append({
                "operation_id": oid,
                "params": dict(params),
                "use_sudo": use_sudo,
            })
        targets.append({"server": srv, "steps": steps})

    return {
        "id": rid or "adhoc_report",
        "name": name,
        "description": desc,
        "parallel_servers": parallel,
        "display_mode": dmode,
        "targets": targets,
    }


class ReportCatalog:
    """Хранилище пользовательских YAML-шаблонов отчётов в profiles/<slug>/reports.d/."""

    def __init__(self, user_dir: Path | None):
        self.user_dir = user_dir
        self.templates: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        self.templates = {}
        d = self.user_dir
        if d is None or not d.exists():
            return
        for path in sorted(d.glob("*.yaml")):
            try:
                raw_text = path.read_text(encoding="utf-8")
                raw = yaml.safe_load(raw_text) or {}
                spec = parse_report_dict(raw, require_id=True)
                rid = spec["id"]
                if rid != path.stem:
                    raise ValueError(f"id {rid!r} не совпадает с именем файла {path.stem!r}")
                spec["file"] = path.name
                spec["valid"] = True
                spec["error"] = None
                self.templates[rid] = spec
            except Exception as e:
                log.error("invalid report template %s: %s", path, e)
                bad_id = path.stem
                self.templates[f"invalid:{bad_id}"] = {
                    "id": bad_id,
                    "name": bad_id,
                    "description": "",
                    "parallel_servers": True,
                    "display_mode": "display_and_raw",
                    "targets": [],
                    "file": path.name,
                    "valid": False,
                    "error": str(e),
                }

    def list(self) -> list[dict]:
        return [dict(v) for v in self.templates.values()]

    def get(self, rid: str) -> dict:
        t = self.templates.get(rid)
        if not t:
            raise AppError("E_NOT_FOUND", f"шаблон отчёта {rid!r} не найден", status=404)
        if not t.get("valid"):
            raise AppError("E_PARAM", t.get("error") or "шаблон невалиден", status=400)
        return dict(t)


def _csv_cell(v) -> str:
    if v is None:
        return ""
    s = str(v)
    if s[:1] in {"=", "+", "-", "@", "\t", "\r"}:
        return "'" + s
    return s


def _display_to_plain_text(disp: dict | None) -> str:
    if not isinstance(disp, dict):
        return ""
    dtype = disp.get("type")
    if dtype == "sections":
        parts = []
        for sec in (disp.get("sections") or []):
            t = sec.get("title")
            body = _display_to_plain_text(sec)
            if t:
                parts.append(f"[{t}]\n{body}")
            elif body:
                parts.append(body)
        return "\n\n".join(parts)
    if dtype == "lines":
        lines = disp.get("lines") or []
        return "\n".join(lines) if lines else (disp.get("empty_text") or "(пусто)")
    if dtype == "kv":
        if disp.get("error"):
            return f"Ошибка display: {disp['error']}"
        items = disp.get("items") or []
        if not items:
            return disp.get("empty_text") or "(пусто)"
        return "\n".join(f"{it['label']}: {it['value']}" for it in items)
    if dtype == "table":
        if disp.get("error"):
            return f"Ошибка display: {disp['error']}"
        cols = disp.get("columns") or []
        rows = disp.get("rows") or []
        if not rows:
            return disp.get("empty_text") or "(пусто)"
        header = " | ".join(c["label"] for c in cols)
        lines = [header]
        for r in rows:
            lines.append(" | ".join(str(r.get(c["key"], "—")) for c in cols))
        return "\n".join(lines)
    return ""


def _display_to_markdown(disp: dict | None) -> list[str]:
    if not isinstance(disp, dict):
        return []
    out: list[str] = []
    title = disp.get("title")
    if title:
        out.append(f"**{title}**")
        out.append("")
    dtype = disp.get("type")
    if dtype == "sections":
        for sec in (disp.get("sections") or []):
            out.extend(_display_to_markdown(sec))
        return out
    if dtype == "lines":
        lines = disp.get("lines") or []
        if not lines:
            out.append(f"_{disp.get('empty_text') or 'Совпадений не найдено.'}_")
        else:
            out.append("```text")
            out.extend(lines)
            out.append("```")
        out.append("")
        return out
    if dtype == "kv":
        if disp.get("error"):
            out.append(f"_Ошибка display: {disp['error']}_")
        else:
            items = disp.get("items") or []
            if not items:
                out.append(f"_{disp.get('empty_text') or 'Данные не найдены.'}_")
            else:
                for it in items:
                    out.append(f"- **{it['label']}:** `{it['value']}`")
        out.append("")
        return out
    if dtype == "table":
        if disp.get("error"):
            out.append(f"_Ошибка display: {disp['error']}_")
        else:
            cols = disp.get("columns") or []
            rows = disp.get("rows") or []
            if not rows:
                out.append(f"_{disp.get('empty_text') or 'Записей не найдено.'}_")
            else:
                def esc(x):
                    return str(x).replace("|", "\\|").replace("\n", " ")
                out.append("| " + " | ".join(esc(c["label"]) for c in cols) + " |")
                out.append("| " + " | ".join("---" for _ in cols) + " |")
                for r in rows:
                    out.append("| " + " | ".join(esc(r.get(c["key"], "—")) for c in cols) + " |")
        out.append("")
        return out
    return out


def _step_raw_stdout(step: dict) -> str:
    parts = []
    for s in (step.get("steps") or []):
        out = (s.get("stdout") or "").strip("\n")
        err = (s.get("stderr") or "").strip("\n")
        prefix = f"[{s.get('phase', 'run')} exit={s.get('exit')}]"
        chunk = prefix
        if out:
            chunk += "\n" + out
        if err:
            chunk += "\nstderr:\n" + err
        parts.append(chunk)
    return "\n\n".join(parts)


def export_report_json(job: dict, display_mode: str) -> bytes:
    servers_out = []
    for srv in (job.get("servers") or []):
        steps_out = []
        for st in (srv.get("steps") or []):
            has_disp = st.get("display_data") is not None
            item = {
                "operation_id": st.get("operation_id"),
                "operation_name": st.get("operation_name"),
                "params": st.get("params") or {},
                "status": st.get("status"),
                "duration_ms": st.get("duration_ms"),
                "sudo_used": bool(st.get("sudo_used")),
                "error_code": st.get("error_code"),
                "error_message": st.get("error_message"),
            }
            if display_mode != "raw_only" and has_disp:
                item["display_data"] = st.get("display_data")
            if display_mode == "raw_only" or display_mode == "display_and_raw" or not has_disp:
                item["steps"] = st.get("steps") or []
            steps_out.append(item)
        servers_out.append({
            "server_id": srv.get("server_id"),
            "server_name": srv.get("server_name"),
            "llm_alias": srv.get("llm_alias"),
            "steps": steps_out,
        })
    payload = {
        "job_id": job.get("id"),
        "name": job.get("name"),
        "description": job.get("description"),
        "status": job.get("status"),
        "display_mode": display_mode,
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "servers": servers_out,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")


def export_report_csv(job: dict, display_mode: str) -> bytes:
    buf = io.StringIO()
    fields = [
        "report_name", "server_id", "server_alias", "server_name",
        "operation_id", "operation_name", "status", "duration_ms",
        "sudo_used", "error_code", "error_message",
    ]
    if display_mode != "raw_only":
        fields.append("display_output")
    if display_mode != "display_only":
        fields.append("raw_output")

    w = csv.writer(buf, lineterminator="\n")
    w.writerow(fields)
    for srv in (job.get("servers") or []):
        for st in (srv.get("steps") or []):
            has_disp = st.get("display_data") is not None
            row = [
                _csv_cell(job.get("name")),
                _csv_cell(srv.get("server_id")),
                _csv_cell(srv.get("llm_alias")),
                _csv_cell(srv.get("server_name")),
                _csv_cell(st.get("operation_id")),
                _csv_cell(st.get("operation_name")),
                _csv_cell(st.get("status")),
                _csv_cell(st.get("duration_ms")),
                _csv_cell("да" if st.get("sudo_used") else "нет"),
                _csv_cell(st.get("error_code")),
                _csv_cell(st.get("error_message")),
            ]
            raw_txt = _step_raw_stdout(st)
            disp_txt = _display_to_plain_text(st.get("display_data")) if has_disp else ""
            if display_mode != "raw_only":
                row.append(_csv_cell(disp_txt if has_disp else raw_txt))
            if display_mode != "display_only":
                row.append(_csv_cell(raw_txt))
            w.writerow(row)
    return buf.getvalue().encode("utf-8-sig")


def export_report_markdown(job: dict, display_mode: str) -> bytes:
    lines: list[str] = [
        f"# Отчёт: {job.get('name') or job.get('id')}",
        "",
    ]
    if job.get("description"):
        lines.extend([job["description"], ""])
    lines.extend([
        f"- **Статус:** `{job.get('status')}`",
        f"- **Начат:** `{job.get('started_at') or '—'}`",
        f"- **Завершён:** `{job.get('finished_at') or '—'}`",
        f"- **Режим вывода:** `{display_mode}`",
        "",
        "## Сводка",
        "",
        "| Сервер | Операция | Статус | Длительность | Ошибка |",
        "| --- | --- | --- | --- | --- |",
    ])
    for srv in (job.get("servers") or []):
        s_lbl = f"{srv.get('server_name')} ({srv.get('llm_alias')})"
        for st in (srv.get("steps") or []):
            dur = f"{st.get('duration_ms')} мс" if st.get("duration_ms") is not None else "—"
            err = st.get("error_code") or ""
            lines.append(
                f"| {s_lbl} | `{st.get('operation_id')}` | `{st.get('status')}` | {dur} | {err} |"
            )
    lines.append("")

    for srv in (job.get("servers") or []):
        lines.extend([
            f"## {srv.get('server_name')} (`{srv.get('llm_alias')}`)",
            "",
        ])
        for st in (srv.get("steps") or []):
            lines.append(f"### {st.get('operation_name') or st.get('operation_id')} (`{st.get('operation_id')}`)")
            lines.append("")
            dur = f" · {st.get('duration_ms')} мс" if st.get("duration_ms") is not None else ""
            sudo_s = " · sudo" if st.get("sudo_used") else ""
            lines.append(f"Статус: **{st.get('status')}**{dur}{sudo_s}")
            lines.append("")
            if st.get("error_message"):
                lines.append(f"> Ошибка `{st.get('error_code') or 'ERR'}`: {st['error_message']}")
                lines.append("")

            has_disp = st.get("display_data") is not None
            if display_mode != "raw_only" and has_disp:
                lines.extend(_display_to_markdown(st.get("display_data")))
            if display_mode == "raw_only" or display_mode == "display_and_raw" or not has_disp:
                raw_txt = _step_raw_stdout(st)
                if raw_txt:
                    if display_mode == "display_and_raw" and has_disp:
                        lines.extend(["<details>", "<summary>Полный вывод команды</summary>", ""])
                    lines.extend(["```text", raw_txt, "```", ""])
                    if display_mode == "display_and_raw" and has_disp:
                        lines.extend(["</details>", ""])
    return "\n".join(lines).encode("utf-8")
