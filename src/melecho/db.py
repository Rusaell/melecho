from __future__ import annotations

import asyncio
import inspect
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  llm_alias TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  user TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  encrypted_credential TEXT,
  credential_nonce TEXT,
  credential_version INTEGER DEFAULT 1,
  encrypted_passphrase TEXT,
  passphrase_nonce TEXT,
  passphrase_version INTEGER DEFAULT 1,
  allowed_units TEXT NOT NULL DEFAULT '[]',
  os_family TEXT NOT NULL,
  key_path TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  timestamp_utc TEXT NOT NULL,
  server_id INTEGER,
  actor TEXT NOT NULL,
  operation_id TEXT,
  action TEXT NOT NULL,
  command TEXT,
  result_meta TEXT,
  result_hash TEXT,
  duration_ms INTEGER,
  sudo_used INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  prev_hmac TEXT NOT NULL,
  entry_hmac TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log(server_id);
CREATE TABLE IF NOT EXISTS metrics_history (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL,
  timestamp_utc TEXT NOT NULL,
  cpu REAL,
  ram REAL,
  disk REAL,
  net_rx INTEGER,
  net_tx INTEGER,
  load_avg TEXT,
  uptime_sec INTEGER,
  resolution TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_server_ts_res
  ON metrics_history(server_id, timestamp_utc, resolution);
CREATE TABLE IF NOT EXISTS llm_cache (
  id INTEGER PRIMARY KEY,
  prompt_hash TEXT NOT NULL,
  model TEXT,
  params_hash TEXT,
  llm_alias TEXT NOT NULL,
  response TEXT,
  provider TEXT,
  tokens_used INTEGER,
  cost REAL,
  created_at TEXT NOT NULL,
  ttl_until TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_cache_hash_alias ON llm_cache(prompt_hash, llm_alias);
CREATE TABLE IF NOT EXISTS llm_audit (
  id INTEGER PRIMARY KEY,
  timestamp_utc TEXT NOT NULL,
  role TEXT,
  provider TEXT,
  model TEXT,
  prompt_hash TEXT,
  data_categories TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  status TEXT,
  server_id INTEGER
);
CREATE TABLE IF NOT EXISTS known_hosts (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT,
  public_key TEXT,
  fingerprint_sha256 TEXT NOT NULL,
  added_at TEXT NOT NULL,
  confirmed_by TEXT,
  replaced_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS known_hosts_history (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT,
  public_key TEXT,
  fingerprint_sha256 TEXT NOT NULL,
  added_at TEXT,
  removed_at TEXT NOT NULL,
  reason TEXT
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.write_lock = asyncio.Lock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA busy_timeout=5000;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.execute("PRAGMA foreign_keys=ON;")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        row = self.conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()
        current = row["v"] or 0
        if current < 1:
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (1, ?, ?)",
                (_now(), "initial schema"),
            )
            current = 1
        # Идемпотентная проверка колонок: SQLite не умеет ADD COLUMN IF NOT EXISTS,
        # а CREATE TABLE IF NOT EXISTS не добавляет колонки в уже существующую таблицу.
        # Версия в schema_migrations могла быть уже выше, а колонки не быть —
        # поэтому проверяем факт наличия через PRAGMA table_info на каждом старте.
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(servers)").fetchall()}
        if "key_path" not in cols:
            self.conn.execute("ALTER TABLE servers ADD COLUMN key_path TEXT")
        if current < 2:
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (2, ?, ?)",
                (_now(), "servers.key_path for local SSH private key"),
            )
        if current < 3:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_profiles (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL UNIQUE,
                  provider TEXT NOT NULL,
                  base_url TEXT NOT NULL,
                  model TEXT NOT NULL,
                  api_key_ct TEXT,
                  api_key_nonce TEXT,
                  api_key_version INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL,
                  last_used_at TEXT
                )
                """
            )
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (3, ?, ?)",
                (_now(), "llm_profiles for multi-provider LLM"),
            )
        if current < 6:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS reaction_rules (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL,
                  enabled INTEGER NOT NULL DEFAULT 1,
                  match_json TEXT NOT NULL,
                  operation_id TEXT NOT NULL,
                  params_json TEXT NOT NULL DEFAULT '{}',
                  run_on_server TEXT NOT NULL DEFAULT 'same_as_alert',
                  sudo_mode TEXT NOT NULL DEFAULT 'never',
                  action_policy TEXT NOT NULL DEFAULT 'confirm',
                  cooldown_sec INTEGER NOT NULL DEFAULT 300,
                  max_attempts_per_alert INTEGER NOT NULL DEFAULT 3,
                  max_depth INTEGER NOT NULL DEFAULT 3,
                  created_at TEXT NOT NULL,
                  updated_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_reaction_rules_enabled
                  ON reaction_rules(enabled);

                CREATE TABLE IF NOT EXISTS reactions (
                  id INTEGER PRIMARY KEY,
                  alert_id INTEGER NOT NULL,
                  rule_id INTEGER NOT NULL,
                  timestamp_utc TEXT NOT NULL,
                  status TEXT NOT NULL,
                  operation_id TEXT NOT NULL,
                  server_id INTEGER,
                  params_json TEXT,
                  sudo_used INTEGER NOT NULL DEFAULT 0,
                  audit_id INTEGER,
                  started_at TEXT,
                  finished_at TEXT,
                  exit_code INTEGER,
                  duration_ms INTEGER,
                  stdout_trunc TEXT,
                  stderr_trunc TEXT,
                  error_code TEXT,
                  confirmed_at TEXT,
                  confirmed_by TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_reactions_alert
                  ON reactions(alert_id);
                CREATE INDEX IF NOT EXISTS idx_reactions_status
                  ON reactions(status, timestamp_utc DESC);
                CREATE INDEX IF NOT EXISTS idx_reactions_server
                  ON reactions(server_id, timestamp_utc DESC);
                """
            )
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (6, ?, ?)",
                (_now(), "reaction_rules, reactions, sudo_unlock (Milestone 2.1)"),
            )

        if current < 5:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS scheduled_check_runs (
                  id INTEGER PRIMARY KEY,
                  check_id INTEGER NOT NULL,
                  timestamp_utc TEXT NOT NULL,
                  server_id INTEGER,
                  status TEXT NOT NULL,
                  exit_code INTEGER,
                  duration_ms INTEGER,
                  audit_id INTEGER,
                  stdout_trunc TEXT,
                  stderr_trunc TEXT,
                  error_code TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_check_runs_check
                  ON scheduled_check_runs(check_id, timestamp_utc DESC);
                CREATE INDEX IF NOT EXISTS idx_check_runs_ts
                  ON scheduled_check_runs(timestamp_utc DESC);
                """
            )
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (5, ?, ?)",
                (_now(), "scheduled_check_runs (Milestone 1.7)"),
            )

        if current < 4:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS alert_rules (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL,
                  enabled INTEGER NOT NULL DEFAULT 1,
                  source TEXT NOT NULL,
                  condition_json TEXT NOT NULL,
                  severity TEXT NOT NULL,
                  server_id INTEGER,
                  cooldown_sec INTEGER NOT NULL DEFAULT 300,
                  builtin INTEGER NOT NULL DEFAULT 0,
                  auto_resolve_json TEXT,
                  muted_until TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_alert_rules_server
                  ON alert_rules(server_id, enabled);
                CREATE INDEX IF NOT EXISTS idx_alert_rules_builtin
                  ON alert_rules(builtin);

                CREATE TABLE IF NOT EXISTS alerts (
                  id INTEGER PRIMARY KEY,
                  fingerprint TEXT NOT NULL,
                  first_seen_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL,
                  repeat_count INTEGER NOT NULL DEFAULT 1,
                  server_id INTEGER,
                  rule_id INTEGER,
                  source TEXT NOT NULL,
                  severity TEXT NOT NULL,
                  title TEXT NOT NULL,
                  description TEXT,
                  metric TEXT,
                  value REAL,
                  threshold REAL,
                  meta_json TEXT,
                  related_audit_id INTEGER,
                  parent_alert_id INTEGER,
                  depth INTEGER NOT NULL DEFAULT 0,
                  status TEXT NOT NULL,
                  resolved_at TEXT,
                  resolved_by TEXT,
                  acknowledged_at TEXT,
                  acknowledged_by TEXT,
                  dismissed_at TEXT,
                  dismissed_by TEXT,
                  muted_until TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_alerts_fp_status
                  ON alerts(fingerprint, status);
                CREATE INDEX IF NOT EXISTS idx_alerts_ts
                  ON alerts(last_seen_at DESC);
                CREATE INDEX IF NOT EXISTS idx_alerts_server
                  ON alerts(server_id, last_seen_at DESC);
                CREATE INDEX IF NOT EXISTS idx_alerts_status
                  ON alerts(status, last_seen_at DESC);

                CREATE TABLE IF NOT EXISTS alert_events (
                  id INTEGER PRIMARY KEY,
                  alert_id INTEGER NOT NULL,
                  timestamp_utc TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  actor TEXT NOT NULL,
                  meta_json TEXT,
                  reaction_id INTEGER,
                  audit_id INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_alert_events_alert
                  ON alert_events(alert_id, timestamp_utc);
                CREATE INDEX IF NOT EXISTS idx_alert_events_ts
                  ON alert_events(timestamp_utc DESC);

                CREATE TABLE IF NOT EXISTS scheduled_checks (
                  id INTEGER PRIMARY KEY,
                  name TEXT NOT NULL,
                  enabled INTEGER NOT NULL DEFAULT 1,
                  operation_id TEXT NOT NULL,
                  params_json TEXT NOT NULL,
                  servers_json TEXT NOT NULL,
                  interval_sec INTEGER NOT NULL,
                  cooldown_sec INTEGER NOT NULL DEFAULT 300,
                  severity_on_fail TEXT NOT NULL DEFAULT 'warning',
                  condition_json TEXT,
                  last_run_at TEXT,
                  last_result TEXT,
                  next_run_at TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_checks_next_run
                  ON scheduled_checks(enabled, next_run_at);

                CREATE TABLE IF NOT EXISTS server_rule_mutes (
                  id INTEGER PRIMARY KEY,
                  server_id INTEGER NOT NULL,
                  rule_id INTEGER NOT NULL,
                  muted_until TEXT,
                  muted_at TEXT NOT NULL,
                  muted_by TEXT NOT NULL,
                  UNIQUE(server_id, rule_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mutes_server
                  ON server_rule_mutes(server_id);
                """
            )
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (4, ?, ?)",
                (_now(), "alerts, rules, checks, mutes (Milestone 1.1)"),
            )

        # v8: extra_params_json на llm_profiles. Расширенные параметры
        # тела запроса к провайдеру (reasoning_effort, chat_template_kwargs
        # и любые другие), которые пользователь задаёт вручную. NULL/пусто
        # = параметров нет, ключ в тело запроса не подмешивается — важно
        # чтобы не сломать работу провайдеров, не принимающих лишних полей.
        # Idempotent-проверка колонки отдельно от current: если БД
        # восстановят из бэкапа со сбитым schema_migrations, но без колонки,
        # ALTER всё равно выполнится.
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(llm_profiles)").fetchall()}
        if "extra_params_json" not in cols:
            self.conn.execute("ALTER TABLE llm_profiles ADD COLUMN extra_params_json TEXT")
        if current < 8:
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (8, ?, ?)",
                (_now(), "llm_profiles.extra_params_json (extra request params)"),
            )

        # v9: servers.nproc. Используется для нормировки абсолютного порога
        # load-average: abs_load_1m_effective = nproc × abs_load_1m_per_cpu
        # NULL до первого успешного test-connection / сбора —
        # в этом случае detector использует fallback nproc=1 (то есть
        # порог = abs_load_1m_per_cpu). Читается однократно через
        # /usr/bin/nproc; при отсутствии coreutils остаётся NULL.
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(servers)").fetchall()}
        if "nproc" not in cols:
            self.conn.execute("ALTER TABLE servers ADD COLUMN nproc INTEGER")
        if current < 9:
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (9, ?, ?)",
                (_now(), "servers.nproc (load threshold per-cpu)"),
            )

        if current < 7:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS operation_server_links (
                  id INTEGER PRIMARY KEY,
                  operation_id TEXT NOT NULL,
                  server_id INTEGER,
                  created_at TEXT NOT NULL,
                  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
                );
                -- SQLite считает NULL различных в UNIQUE: обычный
                -- UNIQUE(operation_id, server_id) позволил бы вставить
                -- несколько «глобальных» строк для одной операции
                -- (server_id IS NULL). COALESCE(server_id, -1) это
                -- закрывает: на одну операцию не более одной глобальной
                -- привязки. Семантика (что значит «глобальная» и что
                -- значит «нет строк вовсе») фиксируется в runtime на
                -- итерации 2, схема её не навязывает.
                CREATE UNIQUE INDEX IF NOT EXISTS uq_op_server_links
                  ON operation_server_links(operation_id, COALESCE(server_id, -1));
                CREATE INDEX IF NOT EXISTS idx_op_server_links_op
                  ON operation_server_links(operation_id);
                """
            )
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (7, ?, ?)",
                (_now(), "operation_server_links (user ops iter 1)"),
            )

        # v10: единая модель правил алертов — АДДИТИВНАЯ миграция.
        #
        # Что делает:
        #   - в alert_rules добавляет колонки condition_kind, description,
        #     last_fired_at, interval_sec, next_run_at, last_run_at,
        #     last_result, servers_json;
        #   - заполняет condition_kind из source для существующих правил;
        #   - конвертирует scheduled_checks в alert_rules (копированием,
        #     с condition_kind='operation_check'); старые таблицы не трогает;
        #   - переписывает reaction_rules.match_json: ключ sources →
        #     condition_kinds с маппингом старых source-имён;
        #   - создаёт индекс idx_alert_rules_due для планировщика.
        #
        # Чего НЕ делает (перенесено в патчи 2–5, вместе с адаптацией
        # runtime.py и UI):
        #   - не дропает alert_rules.source — старый код продолжает читать;
        #   - не дропает scheduled_checks и не переименовывает
        #     scheduled_check_runs — старый планировщик продолжает работать;
        #   - не удаляет lazy-правила "Check failed: *" — на них могут
        #     ссылаться alerts.rule_id и reaction_rules.match_json.rule_ids.
        #
        # Всё в одной транзакции: падение на середине (битый JSON в
        # reaction_rules.match_json, ошибка парсинга) откатывает v10
        # целиком, БД остаётся на v9.
        if current < 10:
            # Закоммитить v1..v9 до начала v10.
            #   1) Python sqlite3 в дефолтном режиме (isolation_level="")
            #      неявно открывает транзакцию при первом DML. К этому
            #      моменту предыдущие ветки _migrate уже сделали
            #      INSERT/ALTER — коннект в транзакции, и явный
            #      BEGIN IMMEDIATE падает с "cannot start a transaction
            #      within a transaction".
            #   2) Семантика: v10 должна быть атомарна (падение на середине
            #      — БД на v9), но v1..v9 откатывать не нужно.
            self.conn.commit()
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                self._migrate_v10()
                self.conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at, description) VALUES (10, ?, ?)",
                    (_now(), "alerts v2: единая модель правил (condition_kind)"),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        # v11: удалить lazy-правила "Check failed: *".
        # Такие правила создавались старым кодом по одному на каждый check
        # при первом fail. В новой модели алерты эмитятся от самого правила
        # operation_check (см. runtime._run_check_on_server), отдельные
        # lazy-правила не нужны. Ссылки в alerts.rule_id обнуляются,
        # id вычищаются из reaction_rules.match_json.rule_ids.
        if current < 11:
            self.conn.commit()
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                self._migrate_v11()
                self.conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at, description) VALUES (11, ?, ?)",
                    (_now(), "cleanup: удалены lazy-правила Check failed: *"),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        # v12: scheduled_check_runs → alert_rule_runs, check_id → rule_id.
        # Чисто переименование в рамках объединения alert_rules и
        # scheduled_checks в одну сущность (PLAN_ALERTS_V2 §3).
        # Ключ retention.check_runs_days и UI-терминология «Проверки»
        # не трогаются — только физическая схема.
        if current < 12:
            self.conn.commit()
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                self._migrate_v12()
                self.conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at, description) VALUES (12, ?, ?)",
                    (_now(), "rename scheduled_check_runs -> alert_rule_runs"),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        # v13: удалить alert_rules.source. Каноническое поле —
        # condition_kind (заполнено в v10). Legacy source как отдельная
        # колонка больше не нужен; маппинг kind → source живёт в
        # alerts.CONDITION_KIND_TO_SOURCE и используется для alerts.source
        # (денормализация для UI) и виртуального поля в API /alert-rules.
        # Индексы source не держат — DROP COLUMN безопасен.
        if current < 13:
            self.conn.commit()
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                self._migrate_v13()
                self.conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at, description) VALUES (13, ?, ?)",
                    (_now(), "alerts v2: drop alert_rules.source"),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        # v14: удалить таблицу scheduled_checks.
        # Данные сконвертированы в alert_rules (v10) с
        # condition_kind='operation_check'; планировщик и CRUD работают
        # поверх alert_rules. FK на scheduled_checks нет — от старых
        # runs осталась только невидимая логическая связь по rule_id
        # (уже alert_rule_runs).
        if current < 14:
            self.conn.commit()
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                self.conn.execute("DROP TABLE IF EXISTS scheduled_checks")
                self.conn.execute("DROP INDEX IF EXISTS idx_checks_next_run")
                self.conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at, description) VALUES (14, ?, ?)",
                    (_now(), "drop scheduled_checks (всё в alert_rules)"),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        # v15: alerts.condition_kind — денормализация типа условия.
        # Нужна для фильтра реакции по источнику: source неоднозначен
        # (check может быть operation_check или reaction_failed).
        # Заполняется в AlertEngine.emit из rule_row.condition_kind;
        # backfill из alerts.source для существующих алертов.
        if current < 15:
            self.conn.commit()
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                self._migrate_v15()
                self.conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at, description) VALUES (15, ?, ?)",
                    (_now(), "alerts.condition_kind (денормализация)"),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

        # v16: servers.id → AUTOINCREMENT + синхронизация llm_alias = server-{id}.
        #
        # Зачем: id и alias — две независимые нумерации; пользователь и LLM
        # путались, что server-1 может иметь id=2. Синхронизируем их так,
        # чтобы число в server-N совпадало с id. AUTOINCREMENT (в отличие
        # от обычного ROWID) гарантирует, что id не переиспользуется после
        # удаления — значит alias не «переедет» на другой сервер.
        #
        # ВАЖНО: миграция пересоздаёт таблицу servers (SQLite не умеет
        # менять PRIMARY KEY на AUTOINCREMENT через ALTER). FK из
        # operation_server_links временно отключаются, чтобы RENAME не
        # переписал их на servers_old.
        if current < 16:
            self._migrate_v16()
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (16, ?, ?)",
                (_now(), "servers.id AUTOINCREMENT + alias=server-{id}"),
            )
            self.conn.commit()

        # v17: servers.host_key_mismatch_at / host_key_mismatch_fp.
        # Флаг "host key сервера не совпадает с сохранённым". Ставится
        # при pre-flight на старте панели или при первой попытке SSH-
        # подключения (connect_real → E_HOSTKEY_MISMATCH). Пока флаг
        # стоит — collect_server пропускает сервер, SSH не открывается.
        # Снимается при успешном коннекте или ротации host key.
        # _fp хранит предъявленный (подозрительный) fingerprint для UI.
        if current < 17:
            cols = {r[1] for r in self.conn.execute("PRAGMA table_info(servers)").fetchall()}
            if "host_key_mismatch_at" not in cols:
                self.conn.execute("ALTER TABLE servers ADD COLUMN host_key_mismatch_at TEXT")
            if "host_key_mismatch_fp" not in cols:
                self.conn.execute("ALTER TABLE servers ADD COLUMN host_key_mismatch_fp TEXT")
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (17, ?, ?)",
                (_now(), "servers.host_key_mismatch_at/fp (S7+ pre-flight)"),
            )
            self.conn.commit()

        # v18: servers.is_local — флаг «локальный сервер».
        # Пользователь сам помечает серверы, которые остаются доступны
        # без внешнего интернета (localhost, LAN, VPN-туннель, extranet).
        # Логика:
        #   - при internet_offline операции приостанавливаются ТОЛЬКО
        #     на внешних серверах (is_local=0);
        #   - на локальных — collect, alerts, reactions, checks работают;
        #   - если ВСЕ серверы локальные, панель вообще не проверяет
        #     интернет (нет внешних точек отказа).
        # Дефолт 0 (внешний) — консервативно: если пользователь забыл
        # пометить локальный сервер, он защищён от ложных SSH-таймаутов.
        # Классификация — ответственность пользователя (никакого
        # автогада по host: 192.168.x может быть extranet, а 10.x —
        # корпоративный VPN с выходом в мир).
        if current < 18:
            cols = {r[1] for r in self.conn.execute("PRAGMA table_info(servers)").fetchall()}
            if "is_local" not in cols:
                self.conn.execute(
                    "ALTER TABLE servers ADD COLUMN is_local INTEGER NOT NULL DEFAULT 0"
                )
            self.conn.execute(
                "INSERT INTO schema_migrations(version, applied_at, description) VALUES (18, ?, ?)",
                (_now(), "servers.is_local (локальный/внешний для интернет-offline)"),
            )
            self.conn.commit()

    def _migrate_v16(self) -> None:
        """Пересоздание servers с AUTOINCREMENT + синхронизация alias.

        PRAGMA foreign_keys=OFF нужен до BEGIN: иначе SQLite при
        RENAME TABLE перепишет FK в operation_server_links на
        servers_old, и после DROP у нас будут битые ссылки.
        """
        # Идемпотентность: если servers уже AUTOINCREMENT (например,
        # fresh install или повторный запуск после успешной миграции) —
        # ничего не делаем.
        row = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='servers'"
        ).fetchone()
        if row and "AUTOINCREMENT" in (row[0] or "").upper():
            return

        self.conn.commit()
        self.conn.execute("PRAGMA foreign_keys=OFF")
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            # Защита от предыдущего упавшего запуска, оставившего хвост.
            self.conn.execute("DROP TABLE IF EXISTS servers_old")
            self.conn.execute("ALTER TABLE servers RENAME TO servers_old")
            self.conn.execute(
                """
                CREATE TABLE servers (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL,
                  llm_alias TEXT NOT NULL UNIQUE,
                  host TEXT NOT NULL,
                  port INTEGER NOT NULL DEFAULT 22,
                  user TEXT NOT NULL,
                  auth_type TEXT NOT NULL,
                  encrypted_credential TEXT,
                  credential_nonce TEXT,
                  credential_version INTEGER DEFAULT 1,
                  encrypted_passphrase TEXT,
                  passphrase_nonce TEXT,
                  passphrase_version INTEGER DEFAULT 1,
                  allowed_units TEXT NOT NULL DEFAULT '[]',
                  os_family TEXT NOT NULL,
                  key_path TEXT,
                  nproc INTEGER,
                  created_at TEXT NOT NULL,
                  last_seen_at TEXT
                )
                """
            )
            self.conn.execute(
                """INSERT INTO servers
                   (id, name, llm_alias, host, port, user, auth_type,
                    encrypted_credential, credential_nonce, credential_version,
                    encrypted_passphrase, passphrase_nonce, passphrase_version,
                    allowed_units, os_family, key_path, nproc,
                    created_at, last_seen_at)
                   SELECT id, name, llm_alias, host, port, user, auth_type,
                          encrypted_credential, credential_nonce, credential_version,
                          encrypted_passphrase, passphrase_nonce, passphrase_version,
                          allowed_units, os_family, key_path, nproc,
                          created_at, last_seen_at
                   FROM servers_old"""
            )
            self.conn.execute("DROP TABLE servers_old")
            # Синхронизация alias = "server-" + id.
            # Двухфазно: первый UPDATE в '__tmp_N' освобождает старые
            # значения, второй ставит финальные. Иначе однопроходный
            # UPDATE ловит UNIQUE-конфликт на пересечении старых и
            # новых имён (server-12 → server-1 при живом server-1 → server-2).
            self.conn.execute(
                "UPDATE servers SET llm_alias = '__tmp_' || id"
            )
            self.conn.execute(
                "UPDATE servers SET llm_alias = 'server-' || id"
            )
            max_id = self.conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS m FROM servers"
            ).fetchone()["m"]
            self.conn.execute(
                "INSERT INTO settings(key, value) VALUES ('server_alias_counter', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(max_id),),
            )
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        finally:
            self.conn.execute("PRAGMA foreign_keys=ON")

    def _migrate_v15(self) -> None:
        """alerts.condition_kind + backfill. Идемпотентно.

        Backfill: source → condition_kind по тому же маппингу, что в
        CONDITION_KIND_TO_SOURCE (alerts.py), но обратно. source='check'
        неоднозначен (operation_check | reaction_failed), но reaction_failed
        пока не эмитится — все существующие 'check' считаем operation_check.
        """
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(alerts)")}
        if "condition_kind" not in cols:
            self.conn.execute("ALTER TABLE alerts ADD COLUMN condition_kind TEXT")
        mapping = {
            "threshold": "metric_threshold",
            "detector":  "metric_zscore",
            "stale":     "metric_stale",
            "operation": "manual_op_failed",
            "check":     "operation_check",
        }
        for src_v, kind in mapping.items():
            self.conn.execute(
                "UPDATE alerts SET condition_kind=? "
                "WHERE source=? AND condition_kind IS NULL",
                (kind, src_v),
            )

    def _migrate_v13(self) -> None:
        """Удаление alert_rules.source. Идемпотентно."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(alert_rules)")}
        if "source" in cols:
            self.conn.execute("ALTER TABLE alert_rules DROP COLUMN source")

    def _migrate_v12(self) -> None:
        """Переименование scheduled_check_runs → alert_rule_runs.

        Идемпотентно: если таблица уже переименована (обрыв предыдущего
        прогона, частично применённая миграция), ничего не делаем.
        Индексы SQLite переименовать не умеет — DROP старых + CREATE новых.
        """
        tables = {
            r[0] for r in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "scheduled_check_runs" in tables and "alert_rule_runs" not in tables:
            self.conn.execute(
                "ALTER TABLE scheduled_check_runs RENAME TO alert_rule_runs"
            )

        # Колонка: check_id → rule_id (только если alert_rule_runs существует).
        tables = {
            r[0] for r in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "alert_rule_runs" in tables:
            cols = {r[1] for r in self.conn.execute("PRAGMA table_info(alert_rule_runs)")}
            if "check_id" in cols and "rule_id" not in cols:
                self.conn.execute(
                    "ALTER TABLE alert_rule_runs RENAME COLUMN check_id TO rule_id"
                )

        # Индексы: старые удаляем (RENAME INDEX не поддерживается),
        # новые создаём IF NOT EXISTS.
        self.conn.execute("DROP INDEX IF EXISTS idx_check_runs_check")
        self.conn.execute("DROP INDEX IF EXISTS idx_check_runs_ts")
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alert_rule_runs_check "
            "ON alert_rule_runs(rule_id, timestamp_utc DESC)"
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alert_rule_runs_ts "
            "ON alert_rule_runs(timestamp_utc DESC)"
        )

    def _migrate_v11(self) -> None:
        """Удаление lazy-правил Check failed: * и чистка ссылок.

        Что чистим:
          - alerts.rule_id            → NULL (правило удаляется);
          - reaction_rules.match_json → убрать id из rule_ids.

        Что НЕ чистим:
          - сами alerts (историю провалов сохраняем);
          - scheduled_check_runs (история прогонов остаётся, FK нет).
        """
        rows = self.conn.execute(
            "SELECT id FROM alert_rules "
            "WHERE source='check' AND builtin=0 AND name LIKE 'Check failed:%'"
        ).fetchall()
        if not rows:
            return
        ids = [r["id"] for r in rows]
        id_set = set(ids)
        ph = ",".join("?" * len(ids))

        self.conn.execute(
            f"UPDATE alerts SET rule_id=NULL WHERE rule_id IN ({ph})", ids
        )

        rr_rows = self.conn.execute(
            "SELECT id, match_json FROM reaction_rules"
        ).fetchall()
        for r in rr_rows:
            if not r["match_json"]:
                continue
            try:
                m = json.loads(r["match_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(m, dict):
                continue
            old = m.get("rule_ids")
            if not isinstance(old, list) or not old:
                continue
            new = [x for x in old if x not in id_set]
            if new == old:
                continue
            m["rule_ids"] = new
            self.conn.execute(
                "UPDATE reaction_rules SET match_json=? WHERE id=?",
                (json.dumps(m, ensure_ascii=False, sort_keys=True), r["id"]),
            )

        self.conn.execute(f"DELETE FROM alert_rules WHERE id IN ({ph})", ids)

    # Соответствие "старый source" → "новый condition_kind".
    # Используется в _migrate_v10 и в миграции reaction_rules.match_json.
    _SOURCE_TO_KIND = {
        "detector": "metric_zscore",
        "threshold": "metric_threshold",
        "stale": "metric_stale",
        "operation": "manual_op_failed",
        "check": "operation_check",
    }

    def _migrate_v10(self) -> None:
        """Тело миграции v10. Вызывается из _migrate внутри BEGIN IMMEDIATE."""
        # 1. Новые колонки alert_rules.
        #    PRAGMA table_info + отдельный ALTER на каждую отсутствующую —
        #    устойчиво к частично применённой миграции (например, если БД
        #    восстановлена из бэкапа, где schema_migrations откачен, а
        #    колонки уже есть).
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(alert_rules)").fetchall()}
        new_cols = {
            "condition_kind": "TEXT",
            "description": "TEXT",
            "last_fired_at": "TEXT",
            "interval_sec": "INTEGER",
            "next_run_at": "TEXT",
            "last_run_at": "TEXT",
            "last_result": "TEXT",
            "servers_json": "TEXT",
        }
        for col, typ in new_cols.items():
            if col not in cols:
                self.conn.execute(f"ALTER TABLE alert_rules ADD COLUMN {col} {typ}")

        # 2. Заполнить condition_kind из source. Только где он ещё NULL —
        #    повторный прогон на частично-мигрированной БД не перезапишет
        #    уже установленные значения.
        for old_source, kind in self._SOURCE_TO_KIND.items():
            self.conn.execute(
                "UPDATE alert_rules SET condition_kind=? "
                "WHERE source=? AND condition_kind IS NULL",
                (kind, old_source),
            )

        # 3. Конвертация scheduled_checks → alert_rules.
        #    Multi-server check: server_id=NULL, servers_json сохраняет
        #    исходный {all:true} | {ids:[...]}. Single-server check:
        #    server_id заполняется, servers_json тоже (для единообразия
        #    чтения в runtime, который ещё предстоит написать).
        #    condition_json в новом формате:
        #      {"operation_id": ..., "params": {...}, "expected": {...}}
        #    source оставляем 'check' — старый код пока фильтрует по source
        #    и не должен преждевременно увидеть эти правила в новых ветках.
        checks = self.conn.execute("SELECT * FROM scheduled_checks").fetchall()
        for c in checks:
            try:
                old_cond = json.loads(c["condition_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                old_cond = {}
            if not isinstance(old_cond, dict):
                old_cond = {}

            try:
                params = json.loads(c["params_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                params = {}
            if not isinstance(params, dict):
                params = {}

            try:
                servers_raw = json.loads(c["servers_json"] or '{"all": true}')
            except (json.JSONDecodeError, TypeError):
                servers_raw = {"all": True}
            if not isinstance(servers_raw, dict):
                servers_raw = {"all": True}

            new_cond = {
                "operation_id": c["operation_id"],
                "params": params,
                "expected": old_cond,
            }

            server_id = None
            if not servers_raw.get("all"):
                ids = servers_raw.get("ids")
                if isinstance(ids, list) and len(ids) == 1 and isinstance(ids[0], int):
                    server_id = ids[0]

            cur = self.conn.execute(
                """INSERT INTO alert_rules
                   (name, enabled, source, condition_json, severity, server_id,
                    cooldown_sec, builtin, auto_resolve_json, muted_until, created_at,
                    condition_kind, interval_sec, next_run_at, last_run_at,
                    last_result, servers_json)
                   VALUES (?, ?, 'check', ?, ?, ?, ?, 0, NULL, NULL, ?,
                           'operation_check', ?, ?, ?, ?, ?)""",
                (
                    c["name"],
                    c["enabled"],
                    json.dumps(new_cond, ensure_ascii=False, sort_keys=True),
                    c["severity_on_fail"],
                    server_id,
                    c["cooldown_sec"],
                    c["created_at"],
                    c["interval_sec"],
                    c["next_run_at"],
                    c["last_run_at"],
                    c["last_result"],
                    json.dumps(servers_raw, ensure_ascii=False, sort_keys=True),
                ),
            )
            # Перепривязать историю прогонов: alert_rules.id != scheduled_checks.id
            # в общем случае (id занимаются builtin и пользовательскими правилами).
            self.conn.execute(
                "UPDATE scheduled_check_runs SET check_id=? WHERE check_id=?",
                (cur.lastrowid, c["id"]),
            )

        # 4. reaction_rules.match_json: sources → condition_kinds.
        rows = self.conn.execute(
            "SELECT id, match_json FROM reaction_rules"
        ).fetchall()
        for r in rows:
            if not r["match_json"]:
                continue
            try:
                m = json.loads(r["match_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(m, dict) or "sources" not in m:
                continue
            old_sources = m.pop("sources") or []
            if not isinstance(old_sources, list):
                old_sources = []
            new_kinds: list[str] = []
            for s in old_sources:
                k = self._SOURCE_TO_KIND.get(s)
                if k and k not in new_kinds:
                    new_kinds.append(k)
            m["condition_kinds"] = new_kinds
            self.conn.execute(
                "UPDATE reaction_rules SET match_json=? WHERE id=?",
                (json.dumps(m, ensure_ascii=False, sort_keys=True), r["id"]),
            )

        # 5. Индекс для планировщика (enabled + next_run_at).
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alert_rules_due "
            "ON alert_rules(enabled, next_run_at)"
        )

    def get_setting(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return None if row is None else row["value"]

    def set_setting(self, key: str, value: str | None) -> None:
        if value is None:
            self.conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        else:
            self.conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    async def mutate(self, fn):
        """Единая точка записи. `fn` ДОЛЖНА быть синхронной функцией,
        принимающей sqlite3.Connection.

        Почему: `BEGIN IMMEDIATE` держит write-lock. Если `fn` начнёт `await`,
        управление вернётся в event loop, но транзакция останется открытой —
        другие писатели будут ждать (или упадут по busy_timeout), а сам вызов
        `fn(self.conn)` вернёт корутину, коммит случится до её выполнения, и
        мы потеряем данные. Поэтому защищаемся явной проверкой.
        """
        if inspect.iscoroutinefunction(fn):
            raise TypeError(
                "Database.mutate() принимает только синхронную функцию. "
                "Для await используйте отдельные async-обёртки и вызывайте "
                "mutate из синхронной секции."
            )
        async with self.write_lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                result = fn(self.conn)
                self.conn.commit()
                return result
            except Exception:
                self.conn.rollback()
                raise

    def close(self) -> None:
        self.conn.close()
