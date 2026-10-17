from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from melecho.errors import AppError
from melecho.runtime import Runtime

log = logging.getLogger("melecho")

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
PUBLIC_EXACT = {("/api/v1/session", "POST")}
PUBLIC_PREFIXES = ("/static/",)
# /favicon.ico и /favicon.svg — оба роута в create_app отдают один файл.
# /assets/ не нужен: статика монтируется на /static.
PUBLIC_PATHS = {"/", "/index.html", "/favicon.ico", "/favicon.svg"}


def _origin_expected(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
    host = request.headers.get("host") or f"{request.url.hostname}:{request.url.port}"
    return f"{proto}://{host}"


def _host_allowed(request: Request, rt: Runtime) -> bool:
    """Host должен содержать явный порт, совпадающий с фактическим портом
    прослушивания. Без этого браузер, обратившийся на порт 80 (Host: localhost),
    мог бы пройти проверку — этого быть не должно.
    """
    host = (request.headers.get("host") or "").split(",")[0].strip()
    port = rt.cfg.http_port
    return host in {f"127.0.0.1:{port}", f"localhost:{port}"}


def _is_public(path: str, method: str) -> bool:
    if (path, method) in PUBLIC_EXACT:
        return True
    if method in {"GET", "HEAD"}:
        if path in PUBLIC_PATHS or path.rstrip("/") == "":
            return True
        if any(path.startswith(p) for p in PUBLIC_PREFIXES):
            return True
    return False


def security_headers() -> dict[str, str]:
    # style-src-attr 'unsafe-inline' — единственный задокументированный fallback
    # для Chart.js 4: Chart пишет style-атрибут на canvas. style-src
    # (без -attr) и script-src остаются строгими.
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "style-src-attr 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'none'; "
        "form-action 'self'"
    )
    return {
        "Content-Security-Policy": csp,
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }


MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MiB — тела запросов у нас крошечные


async def _read_json(request: Request) -> dict:
    """Безопасно читает JSON-тело. Гарантирует возврат dict.

    Отказы:
    - тело больше MAX_BODY_BYTES → 413 E_PARAM (защита от OOM, см. F5);
    - Content-Length не число → 400 E_PARAM;
    - тело пустое → {} (это допустимо для «POST без аргументов»);
    - тело не парсится как JSON → 400 E_PARAM;
    - JSON-корень не объект (null, [], "…", 42) → 400 E_PARAM.
    """
    length = request.headers.get("content-length")
    if length is not None:
        try:
            declared = int(length)
        except ValueError as e:
            raise AppError("E_PARAM", "некорректный Content-Length", status=400) from e
        if declared < 0:
            raise AppError("E_PARAM", "отрицательный Content-Length", status=400)
        if declared > MAX_BODY_BYTES:
            raise AppError("E_PARAM", "тело запроса слишком большое", status=413)
    try:
        raw = await request.body()
    except Exception as e:
        raise AppError("E_PARAM", "не удалось прочитать тело запроса", status=400) from e
    if len(raw) > MAX_BODY_BYTES:
        raise AppError("E_PARAM", "тело запроса слишком большое", status=413)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise AppError("E_PARAM", "тело не является корректным JSON", status=400) from e
    if not isinstance(data, dict):
        raise AppError("E_PARAM", "тело должно быть JSON-объектом", status=400)
    return data


def _require_int(body: dict, key: str, *, min: int | None = None, max: int | None = None) -> int:
    """Извлекает целое из body с валидацией диапазона. bool отвергается
    (в Python True == 1, что для id — бессмыслица)."""
    if key not in body:
        raise AppError("E_PARAM", f"отсутствует поле {key!r}", status=400)
    raw = body[key]
    if isinstance(raw, bool):
        raise AppError("E_PARAM", f"поле {key!r} должно быть целым", status=400)
    try:
        value = int(raw)
    except (TypeError, ValueError) as e:
        raise AppError("E_PARAM", f"поле {key!r} должно быть целым", status=400) from e
    if min is not None and value < min:
        raise AppError("E_PARAM", f"поле {key!r} меньше {min}", status=400)
    if max is not None and value > max:
        raise AppError("E_PARAM", f"поле {key!r} больше {max}", status=400)
    return value


def _require_str(body: dict, key: str, *, default: str = "", strip: bool = True) -> str:
    """Извлекает строку из body. None → default. Не-строка → 400.

    Нужен именно явный isinstance: `body.get(k) or ""` не спасает от
    чисел и списков (они truthy), а потом падает на .strip().
    """
    raw = body.get(key)
    if raw is None:
        return default
    if not isinstance(raw, str):
        raise AppError("E_PARAM", f"поле {key!r} должно быть строкой", status=400)
    return raw.strip() if strip else raw


class Perimeter(BaseHTTPMiddleware):
    def __init__(self, app, rt: Runtime):
        super().__init__(app)
        self.rt = rt

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        method = request.method
        headers_out = security_headers()

        if not _host_allowed(request, self.rt):
            return JSONResponse(
                {"error": {"code": "E_HOST", "message": "недопустимый Host"}},
                status_code=400,
                headers=headers_out,
            )

        public = _is_public(path, method)
        if path == "/api/v1/dev/bootstrap" and not self.rt.cfg.dev_refresh_bootstrap:
            public = False

        if not public:
            token = request.headers.get("x-session-token") or ""
            if not self.rt.session_valid(token):
                return JSONResponse(
                    {"error": {"code": "E_SESSION", "message": "нужна сессия"}},
                    status_code=401,
                    headers=headers_out,
                )

        if method in MUTATING:
            origin = request.headers.get("origin")
            if not origin:
                return JSONResponse(
                    {"error": {"code": "E_ORIGIN", "message": "мутация требует заголовок Origin"}},
                    status_code=400,
                    headers=headers_out,
                )
            expected = _origin_expected(request)
            allowed = {expected}
            port = self.rt.cfg.http_port
            allowed.update(
                {
                    f"http://127.0.0.1:{port}",
                    f"http://localhost:{port}",
                    f"https://127.0.0.1:{port}",
                    f"https://localhost:{port}",
                }
            )
            if origin not in allowed:
                return JSONResponse(
                    {"error": {"code": "E_ORIGIN", "message": "Origin не совпадает"}},
                    status_code=400,
                    headers=headers_out,
                )
            referer = request.headers.get("referer")
            if referer and not any(referer.startswith(a + "/") or referer == a for a in allowed):
                return JSONResponse(
                    {"error": {"code": "E_REFERER", "message": "Referer не совпадает"}},
                    status_code=400,
                    headers=headers_out,
                )

        response = await call_next(request)
        for k, v in headers_out.items():
            response.headers.setdefault(k, v)
        return response


def create_app(rt: Runtime) -> FastAPI:
    app = FastAPI(title="Melecho", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.rt = rt
    static_dir: Path = rt.cfg.static_dir
    index = static_dir / "index.html"

    @app.exception_handler(AppError)
    async def _app_err(_: Request, exc: AppError):
        return JSONResponse(exc.as_body(), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _val(_: Request, exc: RequestValidationError):
        # Детали — только в лог. В ответ уходят фиксированный код и текст,
        # чтобы не раскрывать структуру валидаторов наружу.
        try:
            log.info("validation error: %s", exc.errors()[:3])
        except Exception:
            pass
        return JSONResponse({"error": {"code": "E_PARAM", "message": "некорректный запрос"}}, status_code=400)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("unhandled exception")
        return JSONResponse(
            {"error": {"code": "E_INTERNAL", "message": "внутренняя ошибка сервера"}},
            status_code=500,
        )

    app.add_middleware(Perimeter, rt=rt)

    if (static_dir / "vendor").exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    @app.get("/index.html")
    async def root():
        return FileResponse(index, media_type="text/html; charset=utf-8")

    @app.head("/")
    @app.head("/index.html")
    async def root_head():
        return Response(status_code=200, media_type="text/html; charset=utf-8")

    @app.get("/favicon.svg")
    @app.get("/favicon.ico")
    async def favicon():
        return FileResponse(static_dir / "favicon.svg", media_type="image/svg+xml")

    @app.post("/api/v1/session")
    async def session(request: Request):
        rt.rate.check("session", 10)
        body = await _read_json(request)
        token = body.get("token") or ""
        sess = rt.session_create(token)
        return {"token": sess}

    @app.post("/api/v1/session/logout")
    async def session_logout(request: Request):
        rt.rate.check("session", 10)
        token = request.headers.get("x-session-token") or ""
        rt.session_logout(token)
        # Также чистим файл токена для CLI.
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
        if runtime_dir:
            p = Path(runtime_dir) / "melecho.token"
            try:
                p.unlink()
            except OSError:
                pass
        # Два независимых флага:
        #
        # stop_backend=true   — graceful shutdown процесса. Ответ уходит
        #   до начала shutdown (create_task), клиент видит ok и экран
        #   «Melecho остановлен».
        #
        # unload_profile=true — освободить ресурсы профиля (SSH, БД,
        #   DEK), вернуть свежий bootstrap. Backend продолжает работать,
        #   активный профиль не меняется — пользователь попадает на
        #   стартовый экран и может выбрать любой профиль.
        #   Здесь await'им синхронно: следующий HTTP-запрос от фронта
        #   (location.replace) должен увидеть уже пересозданный Runtime.
        #   Задержка ~1-3 сек (stop_background await'ит фоновые задачи).
        body = await _read_json(request)
        stop_backend = bool(body.get("stop_backend")) if isinstance(body, dict) else False
        unload_profile = bool(body.get("unload_profile")) if isinstance(body, dict) else False
        if stop_backend:
            # Фоном: ответ клиенту должен уйти до начала shutdown.
            asyncio.create_task(rt.request_shutdown())
            return {"ok": True, "stop_backend": True, "unload_profile": False}
        if unload_profile:
            await rt.unload_for_logout()
            return {
                "ok": True,
                "stop_backend": False,
                "unload_profile": True,
                "bootstrap": rt.bootstrap,
            }
        return {"ok": True, "stop_backend": False, "unload_profile": False}

    # ---------- профили ----------
    #
    # Управление профилями данных (изолированные БД + audit.key). Пока
    # только list/create/rename — переключение на другой профиль
    # ("switch") и удаление ("delete current") добавим в этапе 2.2,
    # когда сделаем in-place reload runtime.

    @app.get("/api/v1/profiles")
    async def profiles_list():
        """Список профилей + активный. Требует session: имена профилей
        могут содержать чувствительные обозначения («филиал-X» и т. п.),
        не должны светиться без токена."""
        from melecho.config import list_profiles, read_active_profile
        return {
            "items": list_profiles(),
            "active_slug": read_active_profile(),
        }

    @app.post("/api/v1/profiles")
    async def profiles_create(request: Request):
        """Создать новый профиль. Slug генерируется автоматически из
        имени (транслит + суффикс при коллизии)."""
        from melecho.profiles import create_profile
        rt.rate.check("profile_create", 5)
        body = await _read_json(request)
        name = _require_str(body, "name")
        if not name:
            raise AppError("E_PARAM", "name: непустая строка", status=400)
        try:
            return create_profile(name)
        except ValueError as e:
            raise AppError("E_PARAM", str(e), status=400) from e

    @app.patch("/api/v1/profiles/current")
    async def profiles_rename_current(request: Request):
        """Переименовать активный профиль. Меняет только manifest.json —
        slug (ключ каталога) остаётся. Кэш имени в rt.cfg обновляется
        синхронно (Runtime.rename_current_profile), иначе UI/логи
        показывали бы старое имя до ближайшего switch."""
        body = await _read_json(request)
        name = _require_str(body, "name")
        if not name:
            raise AppError("E_PARAM", "name: непустая строка", status=400)
        return rt.rename_current_profile(name)

    @app.post("/api/v1/profiles/change-password")
    async def profiles_change_password(request: Request):
        """Смена мастер-пароля текущего профиля.

        DEK не меняется — меняется только его обёртка. Все сессии,
        SSH-соединения и расшифрованные секреты в памяти остаются
        нетронутыми (в т.ч. sudo-disk, LLM-ключи).

        Rate-limit 5/мин: защита от перебора старого пароля, если
        сессия угнана. При ошибке расшифровки → E_UNLOCK (как /unlock).
        """
        rt.require_dek()
        rt.rate.check("master_pw_change", 5)
        body = await _read_json(request)
        # Пароли не strip'аем: пользователь может намеренно включить
        # ведущие/хвостовые пробелы. Пустая строка всё равно отсеется.
        old_password = _require_str(body, "old_password", strip=False)
        new_password = _require_str(body, "new_password", strip=False)
        confirm = _require_str(body, "new_password_confirm", strip=False)
        return await rt.change_master_password(old_password, new_password, confirm)

    @app.post("/api/v1/profiles/switch")
    async def profiles_switch(request: Request):
        """Переключиться на другой профиль «на лету».

        Ответ: {ok: true, slug, bootstrap}. bootstrap — новый токен,
        фронт делает location.replace("/#bootstrap=<token>") и заново
        проходит /session. Иначе после reload у фронта нет ни старого
        bootstrap (он одноразовый), ни dev-endpoint (по умолчанию выключен).

        Сессия текущая инвалидируется (sessions обнуляются при unload),
        так что она всё равно не переживёт switch. Возврат bootstrap —
        единственный способ сделать UX гладким.
        """
        from melecho.config import list_profiles
        rt.rate.check("profile_switch", 5)
        body = await _read_json(request)
        slug = _require_str(body, "slug")
        if not slug:
            raise AppError("E_PARAM", "slug: непустая строка", status=400)
        existing = {p["slug"] for p in list_profiles()}
        if slug not in existing:
            raise AppError(
                "E_PROFILE_NOT_FOUND", f"профиль {slug!r} не найден", status=404
            )
        # reload_for_profile сам проверит «то же самое → no-op» и не
        # перезапустит ничего. Но если slug == текущий, возвращаем
        # 200 с уже существующим bootstrap — фронт сделает reload и
        # получит 401 (сессия потеряна)? Нет — если ничего не менялось,
        # сессия жива, и возвращать bootstrap не нужно.
        # Явно разделим случаи, чтобы не порождать неожиданный reload.
        if slug == rt.cfg.profile_slug:
            return {"ok": True, "slug": slug, "bootstrap": None, "noop": True}
        await rt.reload_for_profile(slug)
        # reload_for_profile пересоздал всё, включая bootstrap (mint_bootstrap
        # в _load_profile). Отдаём свежий токен — фронт заменит URL и
        # пройдёт /session.
        return {"ok": True, "slug": slug, "bootstrap": rt.bootstrap}

    @app.post("/api/v1/profiles/delete-current")
    async def profiles_delete_current(request: Request):
        """Удалить текущий профиль. Требует подтверждения именем профиля
        (защита от случайного клика). Переключается на первый оставшийся
        профиль (алфавитно) и удаляет старый каталог.

        Ответ: {ok, slug, bootstrap} — как у switch.
        """
        rt.rate.check("profile_delete", 3)
        body = await _read_json(request)
        confirm_name = _require_str(body, "confirm_name")
        if not confirm_name:
            raise AppError(
                "E_PARAM", "confirm_name: непустая строка", status=400
            )
        if confirm_name != rt.cfg.profile_name:
            raise AppError(
                "E_CONFIRM",
                f"имя не совпадает с текущим профилем ({rt.cfg.profile_name!r})",
                status=400,
            )
        # Защита от удаления последнего профиля живёт в самом методе
        # (E_PROFILE_LAST), чтобы API-ответ содержал осмысленный код.
        await rt.delete_current_profile()
        return {"ok": True, "slug": rt.cfg.profile_slug, "bootstrap": rt.bootstrap}

    @app.get("/api/v1/dev/bootstrap")
    async def dev_bootstrap():
        if not rt.cfg.dev_refresh_bootstrap:
            raise AppError("E_FORBIDDEN", "недоступно (нужен --dev-refresh-bootstrap)", status=404)
        if not rt.bootstrap or time.monotonic() > rt.bootstrap_exp:
            rt.mint_bootstrap()
        left = max(0, int(rt.bootstrap_exp - time.monotonic()))
        return {"token": rt.bootstrap, "ttl_sec": left}

    @app.post("/api/v1/dev/refresh-bootstrap")
    async def dev_refresh():
        if not rt.cfg.dev_refresh_bootstrap:
            raise AppError("E_FORBIDDEN", "флаг --dev-refresh-bootstrap выключен", status=404)
        tok = rt.invalidate_bootstrap()
        return {"token": tok, "ttl_sec": 60}

    @app.get("/api/v1/events/stream")
    async def events_stream(request: Request):
        """SSE-канал для real-time обновлений.

        Клиент подключается через fetch + ReadableStream (не EventSource,
        чтобы передать X-Session-Token). Формат — стандартный SSE:
            data: {"topic":"alert.created","ts":"...","payload":{...}}\n\n

        Heartbeat: раз в 25 секунд отправляем комментарий `: ping\n\n`,
        чтобы прокси/браузер не закрыли «молчащее» соединение.

        Дисконнект: при отключении клиента unsubscribe и выход из генератора.
        """
        rt.require_dek()
        q = rt.events.subscribe()

        def _sse(payload: dict) -> bytes:
            return ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")

        async def gen():
            try:
                # Начальный комментарий: браузер сразу видит «соединение живое».
                yield b": connected\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    if rt._shutdown_event.is_set():
                        # Runtime завершается (Ctrl+C, --stop, «Остановить
                        # и выйти») или перезагружается (switch профиля,
                        # 2.2c). Закрываемся сами — иначе uvicorn ждёт
                        # до timeout_graceful_shutdown=2 и убивает задачу
                        # Cancel'ом, что даёт шум в логе.
                        break
                    # Гонка: новое событие из очереди vs сигнал завершения.
                    # asyncio.wait с timeout — эквивалент wait_for(q.get()),
                    # но с вторым «плечом» (shutdown_event.wait()), которое
                    # завершает ожидание мгновенно.
                    get_task = asyncio.create_task(q.get())
                    sd_task = asyncio.create_task(rt._shutdown_event.wait())
                    try:
                        done, _pending = await asyncio.wait(
                            {get_task, sd_task},
                            timeout=25.0,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        for t in (get_task, sd_task):
                            if not t.done():
                                t.cancel()
                                try:
                                    await t
                                except asyncio.CancelledError:
                                    pass
                    if sd_task in done:
                        break
                    if get_task in done:
                        yield _sse(get_task.result())
                        continue
                    # Таймаут 25 сек — heartbeat.
                    yield b": ping\n\n"
            except asyncio.CancelledError:
                raise
            finally:
                rt.events.unsubscribe(q)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    @app.get("/api/v1/system/status")
    @app.get("/api/v1/system/status")
    async def status():
        return rt.status()

    @app.post("/api/v1/system/check-internet")
    async def check_internet():
        """Ручная проверка соединения с интернетом.

        Вызывается кнопкой «Проверить сейчас» в баннере. Игнорирует
        кэш handshake, ставит checking=true на время проверки (UI
        показывает спиннер), публикует SSE net.status.

        Не требует rate-limit: операция идемпотентная, дешёвая
        (один TCP-handshake с таймаутом 2 сек), пользователь сам
        решает когда нажимать.
        """
        rt.require_dek()
        return await rt.check_internet_now()

    @app.get("/api/v1/system/update-status")
    async def update_status():
        """Текущее состояние проверки обновлений.

        Возвращает:
          check_on_start — включена ли авто-проверка,
          install_kind — git | pipx | pip | flatpak | appimage | docker,
          install_hint — команда обновления (для не-git),
          can_auto_update — можно ли обновить кнопкой,
          available — {version, tag, url} если найдена новая,
          checking — идёт ли HTTP прямо сейчас,
          error — ошибка последней проверки,
          last_check_at — ISO последней проверки,
          apply_state — null | "git_pull" | "pip_install" | "failed" | "done".
        """
        rt.require_dek()
        return rt.update_status()

    @app.post("/api/v1/system/check-updates")
    async def check_updates_now():
        """Ручная проверка обновлений (кнопка «Проверить сейчас»).

        Работает для любого канала установки — HTTP не зависит от git.
        Rate-limit 10/мин: защита от спама в GitHub API.
        """
        rt.require_dek()
        rt.rate.check("update_check", 10)
        return await rt.check_updates_now()

    @app.post("/api/v1/system/apply-update")
    async def apply_update():
        """Применение обновления: git pull + pip install -e . --upgrade.

        Доступно только для install_kind == "git" (для pipx/pip/flatpak
        и т.д. — E_PARAM). По завершении — graceful shutdown backend.
        При ошибке (git conflict, pip fail) — backend продолжает
        работать, в ответе ok=false + message.

        Frontend перед вызовом должен показать предупреждение о локальных
        правках (если есть) и модалку «Обновить и остановить?».
        """
        rt.require_dek()
        # Rate-limit меньше: обновление — редкая операция, но защищаемся
        # от случайного двойного клика (кнопка блокируется на UI, но
        # backend тоже должен отвергнуть повтор).
        rt.rate.check("update_apply", 3)
        return await rt.apply_update()

    @app.post("/api/v1/unlock")
    async def unlock(request: Request):
        rt.rate.check("unlock", 5)
        body = await _read_json(request)
        return await rt.unlock(body.get("password") or "", body.get("confirm"))

    @app.post("/api/v1/sudo/provide")
    async def sudo_provide(request: Request):
        rt.rate.check("sudo", 10)
        rt.require_dek()
        body = await _read_json(request)
        rt.provide_sudo(_require_int(body, "server_id", min=1), body.get("password") or "")
        return {"ok": True}

    @app.post("/api/v1/sudo/forget")
    async def sudo_forget(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        rt.forget_sudo(_require_int(body, "server_id", min=1))
        return {"ok": True}

    @app.get("/api/v1/dashboard/summary")
    async def dashboard():
        rt.require_dek()
        return rt.dashboard()

    @app.get("/api/v1/servers")
    async def servers_list():
        rt.require_dek()
        return {"items": rt.list_servers()}

    @app.post("/api/v1/servers/probe")
    async def servers_probe(request: Request):
        # Не требует DEK: probe — это чистый SSH-handshake без аутентификации.
        # Сессия обязательна (middleware Perimeter): иначе любой на 127.0.0.1
        # мог бы через наш процесс сканировать произвольные host:port.
        body = await _read_json(request)
        # Глобальный предохранитель + per-host лимит (F17). Один клиент не
        # должен перебором проверять десятки хостов нашей внутренней сети.
        rt.rate.check("probe", 30)
        host_raw = (body.get("host") or "").strip().lower()
        if host_raw:
            rt.rate.check_per_host("probe", host_raw, 5)
        return await rt.probe_host_key(body.get("host") or "", body.get("port") or 22)

    @app.post("/api/v1/servers")
    async def servers_add(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.add_server(body)

    @app.post("/api/v1/servers/{sid}/collect")
    async def servers_collect(sid: int):
        rt.require_dek()
        point = await rt.collect_server(sid)
        return {"ok": True, "point": point}

    @app.get("/api/v1/servers/{sid}")
    async def servers_get(sid: int):
        rt.require_dek()
        return rt.public_server(rt.get_server(sid))

    @app.patch("/api/v1/servers/{sid}")
    async def servers_patch(sid: int, request: Request):
        body = await _read_json(request)
        return await rt.patch_server(sid, body)

    @app.delete("/api/v1/servers/{sid}")
    async def servers_del(sid: int):
        return await rt.delete_server(sid)

    @app.post("/api/v1/servers/{sid}/test-connection")
    async def test_conn(sid: int):
        rt.require_dek()
        return await rt.test_connection(sid)

    @app.post("/api/v1/servers/{sid}/confirm-host-key")
    async def confirm_hk(sid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.confirm_host_key(sid, body.get("fingerprint_sha256") or "")

    @app.post("/api/v1/servers/{sid}/host-key/rotate")
    async def rotate_hk(sid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.rotate_host_key(
            sid,
            body.get("fingerprint_sha256") or "",
            body.get("reason") or "",
            bool(body.get("confirm")),
            bool(body.get("confirm2")),
        )

    @app.post("/api/v1/servers/{sid}/refresh-paths")
    async def refresh_paths(sid: int):
        rt.require_dek()
        return await rt.refresh_paths(sid)

    @app.post("/api/v1/servers/{sid}/refresh-nproc")
    async def refresh_nproc(sid: int):
        rt.require_dek()
        return await rt.refresh_nproc(sid)

    @app.get("/api/v1/servers/{sid}/allowed-units")
    async def au_get(sid: int):
        rt.require_dek()
        return rt.allowed_units_get(sid)

    @app.put("/api/v1/servers/{sid}/allowed-units")
    async def au_put(sid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.allowed_units_put(sid, body.get("allowed_units") or [])

    @app.get("/api/v1/servers/{sid}/services")
    async def services(sid: int, q: str = "", page: int = 1, per_page: int = 50):
        rt.require_dek()
        return await rt.list_services(sid, q, page, per_page)

    @app.get("/api/v1/servers/{sid}/metrics")
    async def metrics(
        sid: int,
        resolution: str = "30s",
        ts_from: str | None = None,
        ts_to: str | None = None,
        from_: str | None = Query(None, alias="from"),
        to: str | None = None,
    ):
        rt.require_dek()
        return rt.metrics_query(sid, resolution, from_ or ts_from, to or ts_to)

    @app.post("/api/v1/servers/{sid}/metrics/batch")
    async def metrics_batch(sid: int, request: Request):
        """Метрики за несколько окон одним запросом.

        Body: {"windows": ["15m", "7d"]} (максимум 4).
        Ответ: {"byWindow": {"15m": {...}, "7d": {...}}} — форма
        каждой записи такая же, как у GET /metrics.
        """
        rt.require_dek()
        body = await _read_json(request)
        windows = body.get("windows") or ["15m"]
        return rt.metrics_batch(sid, windows)

    @app.get("/api/v1/operations")
    async def operations():
        rt.require_dek()
        return {"items": rt.catalog.list()}

    # ---------- user operations (Should, iter 2) ----------
    # user-op id в БД и каталоге — "user:<name>". В URL CRUD передаём
    # чистое имя (без префикса) — так проще читать и не нужно
    # экранировать ":". В links-роутах {oid} — полный id (системный
    # или "user:..."): там оид уходит в runtime, который сам решает,
    # что с ним делать.
    #
    # Порядок объявления важен: эти роуты объявлены ДО
    # /api/v1/operations/{oid}/plan, иначе Starlette может поймать
    # /api/v1/operations/user/{x} как {oid}=user.

    @app.get("/api/v1/operations/user")
    async def user_ops_list():
        rt.require_dek()
        items = [op for op in rt.catalog.list() if op.get("source") == "user"]
        # Обогащаем items текущими привязками к серверам: UI показывает
        # статус прямо в карточке. links_get делает один SELECT на
        # операцию; user-операций обычно единицы, это приемлемо.
        for it in items:
            try:
                it["links"] = rt.links_get(it["id"])
            except AppError:
                it["links"] = None
        return {"items": items}

    @app.post("/api/v1/operations/user/validate")
    async def user_op_validate(request: Request):
        """Live-валидация YAML в редакторе. Ничего не сохраняет."""
        rt.require_dek()
        body = await _read_json(request)
        oid = _require_str(body, "id")
        yaml_text = _require_str(body, "yaml", strip=False)
        return rt.validate_user_op_yaml(oid, yaml_text)

    @app.get("/api/v1/operations/user/{oid}")
    async def user_op_get(oid: str):
        rt.require_dek()
        return rt.user_op_get_yaml(oid)

    @app.post("/api/v1/operations/user")
    async def user_op_create(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        oid = _require_str(body, "id")
        yaml_text = _require_str(body, "yaml", strip=False)
        return await rt.user_op_create(oid, yaml_text)

    @app.patch("/api/v1/operations/user/{oid}")
    async def user_op_update(oid: str, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        yaml_text = _require_str(body, "yaml", strip=False)
        return await rt.user_op_update(oid, yaml_text)

    @app.delete("/api/v1/operations/user/{oid}")
    async def user_op_delete(oid: str):
        rt.require_dek()
        return await rt.user_op_delete(oid)

    # ---------- operation links ----------

    @app.get("/api/v1/operations/{oid}/links")
    async def op_links_get(oid: str):
        rt.require_dek()
        return rt.links_get(oid)

    @app.put("/api/v1/operations/{oid}/links")
    async def op_links_set(oid: str, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        is_global = bool(body.get("is_global", False))
        sids_raw = body.get("server_ids") or []
        if not isinstance(sids_raw, list):
            raise AppError("E_PARAM", "server_ids: список", status=400)
        return await rt.links_set(oid, is_global=is_global, server_ids=sids_raw)

    # ---------- catalog whitelist ----------

    @app.get("/api/v1/catalog/whitelist")
    async def whitelist_get():
        rt.require_dek()
        return rt.whitelist_get()

    @app.post("/api/v1/catalog/whitelist")
    async def whitelist_add(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        cmd = _require_str(body, "cmd")
        return await rt.whitelist_add(cmd)

    @app.delete("/api/v1/catalog/whitelist/{cmd}")
    async def whitelist_remove(cmd: str):
        rt.require_dek()
        return await rt.whitelist_remove(cmd)

    @app.post("/api/v1/operations/{oid}/plan")
    async def op_plan(oid: str, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.plan_op(oid, _require_int(body, "server_id", min=1), body.get("params") or {}, body.get("use_sudo"))

    @app.post("/api/v1/operations/{oid}/execute")
    async def op_exec(oid: str, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.execute_op(
            oid, _require_int(body, "server_id", min=1), body.get("params") or {}, body.get("use_sudo"), bool(body.get("confirm"))
        )

    @app.get("/api/v1/audit")
    async def audit(server_id: int | None = None, action: str | None = None, limit: int = 100, offset: int = 0):
        rt.require_dek()
        return rt.audit_list(server_id, action, min(limit, 500), offset)

    @app.get("/api/v1/audit/integrity")
    async def integrity():
        rt.require_dek()
        return rt.integrity()

    @app.get("/api/v1/audit/export")
    async def audit_export():
        rt.require_dek()
        data = rt.csv_audit()
        return Response(
            data,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=audit.csv"},
        )

    @app.get("/api/v1/llm/anomalies")
    async def llm_anoms(server_id: int | None = None):
        rt.require_dek()
        return rt.anomalies(server_id)

    @app.post("/api/v1/llm/explain-anomaly")
    async def llm_explain(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        inc = body.get("include_logs")
        return await rt.explain_anomaly(
            _require_int(body, "server_id", min=1),
            body.get("metric") or "cpu",
            None if inc is None else bool(inc),
        )

    @app.post("/api/v1/llm/suggest-alert-rule")
    async def llm_suggest_alert_rule(request: Request):
        """LLM-предложение правил алертов.

        Body: {"description": "<задача на русском>"}
        Ответ: {explanation, rules, valid_rules, invalid_rules, error, ...}

        Ничего не сохраняет — возвращает черновик для редактора.
        """
        rt.require_dek()
        rt.rate.check("llm_suggest", 10)
        body = await _read_json(request)
        desc = body.get("description") or ""
        # AppError (LLM выключен, пустой desc) бросается синхронно
        # внутри suggest_alert_rule_stream, ДО StreamingResponse —
        # FastAPI отдаст обычный JSON 400.
        return StreamingResponse(
            rt.suggest_alert_rule_stream(desc, history=body.get("history")),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post("/api/v1/llm/suggest-reaction-rule")
    async def llm_suggest_reaction_rule(request: Request):
        """LLM-предложение правила реакции.

        Body: {"description": "<задача на русском>"}
        Ответ: {explanation, rule, valid_rule, error, ...}
        """
        rt.require_dek()
        rt.rate.check("llm_suggest", 10)
        body = await _read_json(request)
        desc = body.get("description") or ""
        return StreamingResponse(
            rt.suggest_reaction_rule_stream(desc, history=body.get("history")),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/v1/llm/audit")
    async def llm_audit():
        rt.require_dek()
        return rt.llm_audit_list()

    @app.post("/api/v1/llm/explain-alert")
    async def llm_explain_alert(request: Request):
        """LLM-объяснение конкретного алерта.

        Body: {"alert_id": 42, "question": "почему упало?"}  question optional.
        Ответ: {explanation, alert_id, provider, model, tokens_in, tokens_out, ...}
        """
        rt.require_dek()
        rt.rate.check("llm_explain", 20)
        body = await _read_json(request)
        aid = _require_int(body, "alert_id", min=1)
        question = body.get("question") or ""
        if not isinstance(question, str):
            raise AppError("E_PARAM", "question: строка", status=400)
        return await rt.explain_alert(aid, question)

    @app.post("/api/v1/llm/explain-rule")
    async def llm_explain_rule(request: Request):
        """LLM-объяснение правила алерта.

        Body: {"rule_id": 42, "question": "почему оно так часто срабатывает?"}
        """
        rt.require_dek()
        rt.rate.check("llm_explain", 20)
        body = await _read_json(request)
        rid = _require_int(body, "rule_id", min=1)
        question = body.get("question") or ""
        if not isinstance(question, str):
            raise AppError("E_PARAM", "question: строка", status=400)
        return await rt.explain_rule(rid, question)

    @app.post("/api/v1/llm/suggest-rule-edit")
    async def llm_suggest_rule_edit(request: Request):
        """LLM-предложение правки правила.

        Body: {"rule_id": 42, "description": "поднять порог до 95"}
        Ответ: {patch, explanation, error, rule_id, ...}
        """
        rt.require_dek()
        rt.rate.check("llm_suggest", 10)
        body = await _read_json(request)
        rid = _require_int(body, "rule_id", min=1)
        desc = body.get("description") or ""
        if not isinstance(desc, str):
            raise AppError("E_PARAM", "description: строка", status=400)
        return StreamingResponse(
            rt.suggest_rule_edit_stream(rid, desc, history=body.get("history")),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post("/api/v1/llm/suggest-operation")
    async def llm_suggest_operation(request: Request):
        """LLM-предложение YAML для user-операции.

        Body: {"description": "<задача на русском>"}
        Ответ: {explanation, yaml, id, valid, error, provider, model,
                tokens_in, tokens_out, prompt_hash}

        Ничего не сохраняет — возвращает черновик для редактора.
        """
        rt.require_dek()
        rt.rate.check("llm_suggest", 10)
        body = await _read_json(request)
        desc = body.get("description") or ""
        return StreamingResponse(
            rt.suggest_operation_stream(desc, history=body.get("history")),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )


    # ---------- alerts ----------

    @app.get("/api/v1/alerts")
    async def alerts_list(
        server_id: int | None = None,
        severity: str | None = None,
        source: str | None = None,
        status: str = "active",
        limit: int = 100,
        offset: int = 0,
    ):
        rt.require_dek()
        if status == "active":
            statuses = ("open", "reacting", "pending_confirmation", "acknowledged")
        elif status == "all":
            statuses = None
        elif status == "resolved":
            statuses = ("resolved",)
        elif status == "dismissed":
            statuses = ("dismissed",)
        else:
            raise AppError("E_PARAM", "status: active|all|resolved|dismissed", status=400)
        return rt.alerts.list_alerts(
            server_id=server_id,
            severity=severity,
            source=source,
            statuses=statuses,
            limit=min(limit, 500),
            offset=offset,
        )

    @app.get("/api/v1/alerts/counts")
    async def alerts_counts():
        rt.require_dek()
        return rt.alerts.counts_by_severity()

    @app.get("/api/v1/alerts/{aid}")
    async def alerts_get(aid: int):
        rt.require_dek()
        row = rt.alerts.get(aid)
        d = dict(row)
        if d.get("meta_json"):
            try:
                d["meta"] = json.loads(d["meta_json"])
            except json.JSONDecodeError:
                d["meta"] = None
        return d

    @app.get("/api/v1/alerts/{aid}/events")
    async def alerts_events(aid: int):
        rt.require_dek()
        rt.alerts.get(aid)
        return {"items": rt.alerts.get_events(aid)}

    @app.post("/api/v1/alerts/{aid}/ack")
    async def alerts_ack(aid: int):
        rt.require_dek()
        ok = await rt.alerts.acknowledge(aid)
        return {"ok": ok}

    @app.post("/api/v1/alerts/{aid}/dismiss")
    async def alerts_dismiss(aid: int):
        rt.require_dek()
        ok = await rt.alerts.dismiss(aid)
        return {"ok": ok}

    @app.post("/api/v1/alerts/{aid}/mute")
    async def alerts_mute(aid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        minutes = _require_int(body, "minutes", min=1, max=60 * 24 * 30)
        until = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        ok = await rt.alerts.mute(aid, until_z=until)
        return {"ok": ok, "muted_until": until}

    @app.delete("/api/v1/alerts/{aid}")
    async def alerts_delete(aid: int):
        rt.require_dek()
        ok = await rt.alerts.hard_delete(aid)
        return {"ok": ok}

    @app.get("/api/v1/alert-rules")
    async def alert_rules_list(
        kind: str | None = None,
        severity: str | None = None,
        server_id: int | None = None,
        enabled: bool | None = None,
    ):
        rt.require_dek()
        return {"items": rt.alerts.list_rules(
            kind=kind, severity=severity,
            server_id=server_id, enabled=enabled,
        )}

    @app.post("/api/v1/alert-rules")
    async def alert_rules_create(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.alert_rule_create(body)

    @app.post("/api/v1/alert-rules/check-duplicate")
    async def alert_rules_check_duplicate(request: Request):
        """Проверка правила на дубли/конфликты. Ничего не сохраняет.

        Body: тело правила (как в POST /alert-rules).
        Ответ: {exact_duplicate, conflicts, overrides}.
        UI вызывает перед сохранением.
        """
        rt.require_dek()
        body = await _read_json(request)
        return rt.check_duplicate(body)

    @app.get("/api/v1/alert-rules/{rid}")
    async def alert_rules_get(rid: int):
        rt.require_dek()
        return rt.alert_rule_get(rid)

    @app.post("/api/v1/alert-rules/{rid}/run-now")
    async def alert_rules_run_now(rid: int):
        """Запуск operation_check-правила сейчас (вне расписания).
        Для остальных типов правил — E_PARAM."""
        rt.require_dek()
        rt.rate.check("check_run", 10)
        return await rt.run_rule_now(rid)

    @app.get("/api/v1/alert-rules/{rid}/runs")
    async def alert_rules_runs(rid: int, limit: int = 100):
        """История прогонов operation_check-правила."""
        rt.require_dek()
        return rt.list_rule_runs(rid, limit)

    @app.patch("/api/v1/alert-rules/{rid}")
    async def alert_rules_update(rid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.alert_rule_update(rid, body)

    @app.delete("/api/v1/alert-rules/{rid}")
    async def alert_rules_delete(rid: int):
        rt.require_dek()
        return await rt.alert_rule_delete(rid)

    @app.post("/api/v1/alert-rules/{rid}/reset")
    async def alert_rules_reset(rid: int):
        rt.require_dek()
        return await rt.alert_rule_reset(rid)

    @app.post("/api/v1/alert-rules/reset-defaults")
    async def alert_rules_reset_defaults():
        rt.require_dek()
        return await rt.alert_rules_reset_defaults()

    @app.post("/api/v1/alert-rules/disable-all")
    async def alert_rules_disable_all():
        rt.require_dek()
        return await rt.alert_rules_disable_all()

    @app.post("/api/v1/alert-rules/{rid}/mute")
    async def alert_rules_mute(rid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        minutes = _require_int(body, "minutes", min=1, max=60 * 24 * 30)
        until = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        ok = await rt.alerts.mute_rule(rid, until_z=until)
        return {"ok": ok, "muted_until": until}

    # ---------- sudo unlock ----------

    @app.get("/api/v1/sudo/unlock/status")
    async def sudo_unlock_status():
        rt.require_dek()
        return rt.sudo_unlock_status()

    @app.post("/api/v1/sudo/unlock/check")
    async def sudo_unlock_check(request: Request):
        rt.require_dek()
        rt.rate.check("sudo_unlock_check", 10)
        body = await _read_json(request)
        password = body.get("password") or ""
        sid = body.get("server_id")
        if sid is not None:
            sid = _require_int(body, "server_id", min=1)
        return await rt.sudo_check_password(password, sid)

    @app.post("/api/v1/sudo/unlock/provide")
    async def sudo_unlock_provide(request: Request):
        rt.require_dek()
        rt.rate.check("sudo_unlock", 5)
        body = await _read_json(request)
        password = body.get("password") or ""
        mode = body.get("mode") or "session"
        return await rt.sudo_unlock_provide(password, mode)

    @app.post("/api/v1/sudo/unlock/revoke")
    async def sudo_unlock_revoke():
        rt.require_dek()
        return await rt.sudo_unlock_revoke()

    # ---------- emergency stop ----------

    @app.get("/api/v1/automation/state")
    async def automation_state():
        rt.require_dek()
        return rt.emergency_state()

    @app.post("/api/v1/automation/stop-all")
    async def automation_stop_all():
        rt.require_dek()
        return await rt.emergency_stop()

    @app.post("/api/v1/automation/resume-all")
    async def automation_resume_all():
        rt.require_dek()
        return await rt.emergency_resume()

    # ---------- reaction rules ----------

    @app.get("/api/v1/reaction-rules")
    async def reaction_rules_list():
        rt.require_dek()
        return rt.reactions.list_rules()

    @app.post("/api/v1/reaction-rules")
    async def reaction_rules_create(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.reactions.create_rule(body)

    @app.get("/api/v1/reaction-rules/{rid}")
    async def reaction_rules_get(rid: int):
        rt.require_dek()
        return rt.reactions._public_rule(rt.reactions.get_rule(rid))

    @app.patch("/api/v1/reaction-rules/{rid}")
    async def reaction_rules_update(rid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.reactions.update_rule(rid, body)

    @app.delete("/api/v1/reaction-rules/{rid}")
    async def reaction_rules_delete(rid: int):
        rt.require_dek()
        return await rt.reactions.delete_rule(rid)

    # ---------- reactions ----------

    @app.get("/api/v1/reactions")
    async def reactions_list(
        alert_id: int | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ):
        rt.require_dek()
        if status and status not in (
            "running", "pending_confirmation", "ok", "failed", "timeout", "cancelled"
        ):
            raise AppError("E_PARAM", "status: некорректный", status=400)
        return rt.reactions.list_reactions(
            alert_id=alert_id, status=status, limit=limit, offset=offset
        )

    @app.get("/api/v1/reactions/pending")
    async def reactions_pending():
        rt.require_dek()
        return {
            "items": rt.reactions.list_reactions(status="pending_confirmation", limit=200)["items"],
            "count": rt.reactions.pending_count(),
        }

    @app.get("/api/v1/reactions/{rid}")
    async def reactions_get(rid: int):
        rt.require_dek()
        return dict(rt.reactions.get_reaction(rid))

    @app.post("/api/v1/reactions/{rid}/confirm")
    async def reactions_confirm(rid: int):
        rt.require_dek()
        return await rt.reactions.confirm(rid)

    @app.post("/api/v1/reactions/{rid}/cancel")
    async def reactions_cancel(rid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.reactions.cancel(rid, reason=body.get("reason") or "")

    # ---------- LLM profiles ----------

    @app.get("/api/v1/llm/presets")
    async def llm_presets():
        rt.require_dek()
        from melecho.llm import LLM_PRESETS

        return {"items": LLM_PRESETS}

    @app.get("/api/v1/llm/profiles")
    async def llm_profiles_list():
        rt.require_dek()
        return rt.list_llm_profiles()

    @app.post("/api/v1/llm/profiles")
    async def llm_profiles_create(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.create_llm_profile(body)

    @app.patch("/api/v1/llm/profiles/{pid}")
    async def llm_profiles_update(pid: int, request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.update_llm_profile(pid, body)

    @app.delete("/api/v1/llm/profiles/{pid}")
    async def llm_profiles_delete(pid: int):
        rt.require_dek()
        return await rt.delete_llm_profile(pid)

    @app.post("/api/v1/llm/profiles/{pid}/activate")
    async def llm_profiles_activate(pid: int):
        rt.require_dek()
        return await rt.activate_llm_profile(pid)

    @app.post("/api/v1/llm/profiles/test")
    async def llm_profiles_test(request: Request):
        rt.require_dek()
        rt.rate.check("llm_test", 10)
        body = await _read_json(request)
        return await rt.test_llm_profile(body)

    @app.post("/api/v1/llm/profiles/models")
    async def llm_profiles_models(request: Request):
        rt.require_dek()
        rt.rate.check("llm_models", 10)
        body = await _read_json(request)
        return await rt.list_llm_models(body)

    @app.post("/api/v1/llm/chat")
    async def llm_chat(request: Request):
        """SSE-поток ответа LLM. Content-Type: text/event-stream.

        Тело: {"messages": [{role, content}, ...], "max_tokens": 400}
        События (по одному в строке `data: {...}\n\n`):
          {"type":"chunk","text":"..."}
          {"type":"done"}
          {"type":"error","code":"E_LLM_...","message":"..."}
        """
        rt.require_dek()
        rt.rate.check("llm_chat", 20)
        body = await _read_json(request)
        # Валидация тела — до старта стрима. Неправильный формат возвращаем
        # обычным JSON 400 (AppError), а не SSE-событием после 200.
        messages, max_tokens = rt.validate_chat_request(body)

        def _sse(payload: dict) -> bytes:
            return ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")

        async def gen():
            try:
                async for chunk in rt.chat_stream(messages, max_tokens=max_tokens):
                    yield _sse({"type": "chunk", "text": chunk})
                yield _sse({"type": "done"})
            except AppError as e:
                yield _sse({"type": "error", "code": e.code, "message": e.message})
            except Exception:
                log.exception("llm_chat stream error")
                yield _sse({"type": "error", "code": "E_INTERNAL", "message": "внутренняя ошибка стрима"})

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/v1/settings")
    async def settings_get():
        rt.require_dek()
        return rt.settings_get()

    @app.patch("/api/v1/settings")
    async def settings_patch(request: Request):
        rt.require_dek()
        body = await _read_json(request)
        return await rt.settings_patch(body)

    # ---------- retention ----------

    @app.get("/api/v1/retention/status")
    async def retention_status():
        """Состояние хранения данных: правила, значения, план удаления.

        Делает COUNT(*) по каждой таблице — не бесплатно. Вызывать
        по кнопке «Обновить», не поллить.
        """
        rt.require_dek()
        return rt.retention_status()

    @app.patch("/api/v1/retention/settings")
    async def retention_settings(request: Request):
        """Обновление сроков хранения.

        body: {"metrics_raw_days": 3, "alerts_days": 90, ...}
        Ключи — без префикса retention. Неизвестные → E_PARAM.
        Значения клампятся по min/max из RULES (см. app/retention.py).
        """
        rt.require_dek()
        body = await _read_json(request)
        return await rt.retention_update(body)

    @app.post("/api/v1/retention/run")
    async def retention_run(request: Request, dry_run: bool = True):
        """Прогон retention.

        ?dry_run=true (по умолчанию) — только план, ничего не удаляется.
        ?dry_run=false — реальное удаление. Возвращает пофайловый отчёт.
        """
        rt.require_dek()
        rt.rate.check("retention_run", 10)
        return await rt.retention_run(dry_run=dry_run)

    return app
