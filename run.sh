#!/bin/sh
# Melecho — dev-лаунчер. Авто-venv, авто-установка, запуск.
# Для pipx-установки этот файл не нужен: `pipx install melecho && melecho`.
set -eu
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
    echo "Создаю виртуальное окружение..." >&2
    python3 -m venv .venv
    .venv/bin/pip install -U pip setuptools >/dev/null
fi

if [ ! -f .venv/.melecho-installed ]; then
    echo "Устанавливаю зависимости..." >&2
    .venv/bin/pip install -e . >&2
    touch .venv/.melecho-installed
fi

exec .venv/bin/melecho "$@"
