# Melecho

Локальная ИС управления Linux-серверами через SSH: метрики,
алерты, реакции, HMAC-аудит, LLM-объяснитель. Local-first,
без агента на серверах.

<p align="center">
  <img src="images/dashboard.webp" alt="Дашборд Melecho" width="880" />
</p>

## Установка

### Через pipx (рекомендуется)

```bash
pipx install melecho
melecho
```
Демон запустится, браузер откроется автоматически.

Если melecho не находится после установки — добавьте ~/.local/bin
в $PATH:
- bash — export PATH="$HOME/.local/bin:$PATH" в ~/.bashrc
- zsh — то же в ~/.zshrc
- fish — fish_add_path $HOME/.local/bin

Из исходников (git)
```bash
git clone https://github.com/Rusaell/melecho.git
cd melecho
./run.sh
```
run.sh создаст виртуальное окружение, установит зависимости
и запустит Melecho. Повторный запуск — мгновенный.

Для работы в терминале: ./run.sh --foreground.

### Через Docker (Linux и Windows)

Подходит для запуска на Windows (через Docker Desktop / WSL2) и любых Linux-дистрибутивах без установки Python:

**Быстрый интерактивный запуск (сам соберёт, откроет браузер и даст меню):**
- Linux: `./docker-menu.sh`
- Windows (двойной клик или консоль): `docker-menu.bat` (или `.\docker-menu.ps1`)

**Либо вручную через Docker Compose (образ скачивается с `ghcr.io`, либо собирается локально с `--build`):**
```bash
docker compose pull && docker compose up -d
docker compose logs -f
```

В логах появится одноразовая ссылка вида `http://127.0.0.1:8765/#bootstrap=...` — откройте её в браузере.

- **Если вкладка закрыта:** получить новую ссылку без перезапуска контейнера:
  ```bash
  docker compose exec melecho melecho --no-browser
  ```
  Либо выбрать нужный пункт в терминальном интерфейсе в windows (при запуске через docker-menu.bat).
- **SSH-ключи:** можно загрузить приватный ключ прямо в браузере (шифруется DEK внутри тома профиля), либо положить ключи в `./ssh` в корне проекта (появятся в авто-списке под полем пути как `/root/.ssh/...`), пример: "./ssh/id_ed*"
- **Остановка:** `docker compose down` (данные профилей и ключи аудита сохраняются в именованных томах Docker) или из UI "остановить и выйти".

Развёрнутая документация появится позже.

Лицензия
GPL-3.0-or-later. См. LICENSE.
