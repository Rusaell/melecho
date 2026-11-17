#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p ssh

open_browser() {
  local url="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 &
  fi
}

get_running_cid() {
  local cid
  cid="$(docker compose ps -q melecho 2>/dev/null || true)"
  if [[ -n "$cid" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)" == "true" ]]; then
    echo "$cid"
    return 0
  fi
  return 1
}

wait_ready() {
  local i
  for i in $(seq 1 30); do
    if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/', timeout=1)" >/dev/null 2>&1 \
       || curl -fsS http://127.0.0.1:8765/ >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

get_and_open_url() {
  if ! wait_ready; then
    echo "Контейнер не отвечает на 127.0.0.1:8765."
    return 1
  fi
  local url
  url="$(docker compose exec -T melecho melecho --no-browser | tr -d '\r' | tail -n 1)"
  if [[ "$url" == http://* ]]; then
    echo "Ссылка для входа: $url"
    open_browser "$url"
  else
    echo "Не удалось получить ссылку: $url"
  fi
}

ensure_running() {
  if get_running_cid >/dev/null; then
    return 0
  fi
  echo "Запускаю Melecho в Docker..."
  if docker compose up -d --pull never >/dev/null 2>&1; then
    return 0
  elif docker compose pull 2>/dev/null; then
    docker compose up -d
  elif [[ -f "Dockerfile" ]]; then
    echo "Готовый образ в registry недоступен — собираю локально..."
    docker compose up -d --build
  else
    echo "ОШИБКА: Образ не найден локально и недоступен в registry."
    return 1
  fi
}

ensure_running
get_and_open_url || true

while true; do
  if ! get_running_cid >/dev/null; then
    echo ""
    echo "Контейнер Melecho остановлен. Выход из меню."
    exit 0
  fi
  echo ""
  echo "=== Melecho (Docker) ==="
  echo "  [1] Получить новую ссылку и открыть браузер"
  echo "  [2] Показать логи (Ctrl+C — возврат в меню, сервис продолжит работать)"
  echo "  [3] Статус контейнера"
  echo "  [4] Остановить контейнер (docker compose down)"
  echo "  [5] Обновить / пересобрать образ"
  echo "  [0] Выйти из меню (контейнер останется работать в фоне)"
  echo -n "Выбор: "
  ans=""
  while true; do
    if read -r -t 1 -n 1 ch; then
      if [[ -z "$ch" ]]; then
        continue
      fi
      echo ""
      ans="$ch"
      break
    fi
    if ! get_running_cid >/dev/null; then
      echo ""
      echo "Контейнер Melecho остановлен. Выход из меню."
      exit 0
    fi
  done

  case "$ans" in
    1)
      ensure_running
      get_and_open_url || true
      ;;
    2)
      docker compose logs -n 50 -f || true
      ;;
    3)
      docker compose ps
      docker compose exec -T melecho melecho --status || true
      ;;
    4)
      docker compose down
      echo "Контейнер остановлен."
      exit 0
      ;;
    5)
      if docker compose pull 2>/dev/null; then
        docker compose up -d
      elif [[ -f "Dockerfile" ]]; then
        docker compose up -d --build
      else
        docker compose up -d --pull never
      fi
      get_and_open_url || true
      ;;
    0|q|Q)
      exit 0
      ;;
    *)
      echo "Неизвестная команда."
      ;;
  esac
done
