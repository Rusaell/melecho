# Melecho

Локальная ИС управления Linux-серверами через SSH.

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

Развёрнутая документация появится позже.

Лицензия
GPL-3.0-or-later. См. LICENSE.
