# Changelog

Все значимые изменения проекта Melecho.
Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).
Проект придерживается [Semantic Versioning](https://semver.org/lang/ru/).

## [1.0.0] — 2026-10-16

Первый публичный релиз.

### Добавлено

**Ядро.**
- Локальная ИС управления Linux через SSH — без агента на серверах.
- HMAC-chain + signed head, ключ аудита вне БД (S2, S8).
- Argon2id v1 + AES-256-GCM, DEK, шифрование креденшелов и sudo-пароля.
- Терминал-агностичный POSIX-shell (`run_argv` через `/bin/sh -c`).
- CLI-лаунчер: детач через `Popen(start_new_session=True)`, attach
  через `SIGUSR1`, lock через `flock`, `--status` / `--stop` /
  `--install-desktop`.

**SSH.**
- Pre-fetch host key + pinning (S7), отказ без «продолжить».
- S7+ pre-flight host key на старте панели (фоновый probe).
- Все сценарии аутентификации: ключ без passphrase, ключ с passphrase,
  ключ + пароль (fallback), только пароль, keyboard-interactive.
- Редактирование `user` / `auth_type` / `credential` / `passphrase` /
  `key_path` в Настройках сервера.
- Auto-reconnect с backoff 5→10→20→40→60 с.

**Метрики и алерты.**
- CPU / RAM / Disk / Net / Load / Uptime, один SSH-exec на тик.
- EWMA + z-score (warmup 30 residuals), cross-severity, fingerprint-дедуп.
- Единая модель правил алертов: `alert_rules.condition_kind` (6 типов),
  7 builtin-правил.
- 6 типов: `metric_threshold`, `metric_zscore`, `metric_stale`,
  `operation_check`, `manual_op_failed`, `reaction_failed`.
- Reaction Engine: hardcode `confirm` для dangerous/state-changing,
  kill switch.
- Автосудо: 5 режимов, `disk` — зашифрован DEK, переживает рестарт.

**Различение «нет интернета» / «сервер недоступен».**
- TCP-handshake к настраиваемому хосту, флаг `internet_offline`.
- Флаг `servers.is_local` — локальные серверы работают при offline.
- Активный polling с backoff 5→10→20→30 сек.
- Баннер в шапке (4 состояния), countdown, ручная проверка.
- Блюр динамики карточки для внешних серверов при заморозке.

**LLM.**
- OpenAI-совместимый клиент, профили в БД, ключи шифрованы DEK.
- Стриминг `/llm/chat` (SSE), reasoning-фильтр.
- Suggest-стримы на SSE с построчным fence-парсером.
- LLM-команды: `/operation`, `/alert`, `/reaction`, `/explain`,
  `/explain-rule`, `/edit-rule`, `/help`.
- История диалога через `history`, изоляция режимов.
- Канарейки (S4), allowlist полей, opt-in на сырые логи (S5).

**UI.**
- Preact + htm без бандлера, Chart.js 4, вендорится локально.
- Двухуровневый скролл, кастомный скроллбар.
- Drag-n-drop карточек серверов и метрик (pointer events + ghost + FLIP).
- Панель метрик: batch-эндпоинт, per-metric окна, cutoff, per-server
  layout в localStorage.
- Плавающее окно LLM-чата.
- Баннер интернета в шапке, badge «доступно обновление».

**Инфраструктура.**
- Проверка обновлений: `detect_install_kind`, фоновый цикл, UI-секция,
  badge, автообновление для git-клона.
- Graceful shutdown: `SIGTERM` → `should_exit`, кнопка «Остановить и
  выйти» в UI.
- XDG-пути, pipx-установка, `.desktop`-интеграция.

### Инварианты

- S1: на управляемых серверах нет новых слушающих портов.
- S2: HMAC-chain + signed head, ключ аудита вне БД.
- S3: инъекции в параметры каталога блокируются (argv + whitelist).
- S4: секреты не уходят в LLM.
- S5: сырые логи не уходят в LLM по умолчанию.
- S6: Host / Origin / CSP / session-токен.
- S7: mismatch host key → отказ без «продолжить».
- S8: ключ аудита не в БД и не в `VACUUM INTO`.


[1.0.0]: https://github.com/Rusaell/melecho/releases/tag/v1.0.0