[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
if (-not (Test-Path "ssh")) { New-Item -ItemType Directory -Path "ssh" | Out-Null }

function Invoke-Safe {
    param([scriptblock]$Command)
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & $Command 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $oldPref
    return $exitCode
}

function Safe-Docker-Pull {
    Write-Host "Проверка/скачивание образа из registry..." -ForegroundColor Cyan
    $res = Invoke-Safe { & docker compose pull }
    return ($res -eq 0)
}

function Get-RunningContainerId {
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $cid = (& docker compose ps -q melecho 2>$null)
    $ErrorActionPreference = $oldPref
    if (-not $cid) { return $null }
    $cid = ($cid | Select-Object -First 1).Trim()
    if (-not $cid) { return $null }
    $ErrorActionPreference = "SilentlyContinue"
    $running = (& docker inspect -f '{{.State.Running}}' $cid 2>$null)
    $ErrorActionPreference = $oldPref
    if ($running -eq "true") { return $cid }
    return $null
}

function Wait-Ready {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8765/" -UseBasicParsing -TimeoutSec 1
            if ($resp.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Ensure-Running {
    $cid = Get-RunningContainerId
    if ($cid) { return $cid }

    Write-Host "Запускаю Melecho в Docker..."
    $upCode = Invoke-Safe { & docker compose up -d --pull never }
    if ($upCode -ne 0) {
        if (Safe-Docker-Pull) {
            $upCode = Invoke-Safe { & docker compose up -d }
        } elseif (Test-Path "Dockerfile") {
            Write-Host "Готовый образ не найден — собираю локально из Dockerfile..." -ForegroundColor Cyan
            $upCode = Invoke-Safe { & docker compose up -d --build }
        }
    }

    if ($upCode -ne 0) {
        Write-Host "ОШИБКА: Не удалось запустить контейнер Melecho." -ForegroundColor Red
        Write-Host "Убедитесь, что Docker Desktop запущен, и образ загружен (docker load -i melecho-img.tar или есть доступ к ghcr.io)." -ForegroundColor Red
        return $null
    }
    return (Get-RunningContainerId)
}

function Get-And-OpenUrl {
    if (-not (Wait-Ready)) {
        Write-Host "Контейнер не отвечает на 127.0.0.1:8765." -ForegroundColor Yellow
        return
    }
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $out = (& docker compose exec -T melecho melecho --no-browser 2>&1 | Select-Object -Last 1)
    $ErrorActionPreference = $oldPref
    if ($out) { $out = $out.ToString().Trim() }

    if ($out -like "http://*") {
        Write-Host "Ссылка для входа: $out" -ForegroundColor Green
        Start-Process $out
    } else {
        Write-Host "Не удалось получить ссылку: $out" -ForegroundColor Red
    }
}

function Read-MenuChoice {
    param([string]$ContainerId)
    Write-Host -NoNewline "Выбор: "
    while ($true) {
        try {
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq "Enter") { continue }
                $ch = [string]$key.KeyChar
                Write-Host $ch
                return $ch
            }
        } catch {
            return (Read-Host)
        }
        if ($ContainerId) {
            if (-not (Get-RunningContainerId)) {
                Write-Host ""
                Write-Host "Контейнер Melecho остановлен. Закрываю меню..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
                return "__STOPPED__"
            }
        }
        Start-Sleep -Milliseconds 300
    }
}

$activeCid = Ensure-Running
if (-not $activeCid) { exit 1 }
Get-And-OpenUrl

while ($true) {
    $activeCid = Get-RunningContainerId
    if (-not $activeCid) {
        Write-Host "Контейнер Melecho остановлен. Закрываю меню..." -ForegroundColor Yellow
        Start-Sleep -Seconds 2
        exit 0
    }
    Write-Host ""
    Write-Host "=== Melecho (Docker) ==="
    Write-Host "  [1] Получить новую ссылку и открыть браузер"
    Write-Host "  [2] Показать логи (Ctrl+C — возврат в меню, сервис продолжит работать)"
    Write-Host "  [3] Статус контейнера"
    Write-Host "  [4] Остановить контейнер (docker compose down)"
    Write-Host "  [5] Обновить / пересобрать образ"
    Write-Host "  [0] Выйти из меню (контейнер останется работать в фоне)"
    $ans = Read-MenuChoice -ContainerId $activeCid
    switch ($ans) {
        "__STOPPED__" { exit 0 }
        "1" {
            $activeCid = Ensure-Running
            if ($activeCid) { Get-And-OpenUrl }
        }
        "2" {
            try { & docker compose logs -n 50 -f } catch {}
        }
        "3" {
            & docker compose ps
            try { & docker compose exec -T melecho melecho --status } catch {}
        }
        "4" {
            Invoke-Safe { & docker compose down }
            Write-Host "Контейнер остановлен."
            exit 0
        }
        "5" {
            if (Safe-Docker-Pull) {
                Invoke-Safe { & docker compose up -d }
            } elseif (Test-Path "Dockerfile") {
                Invoke-Safe { & docker compose up -d --build }
            } else {
                Write-Host "Не удалось обновить образ (нет сети). Использую текущую версию." -ForegroundColor Yellow
                Invoke-Safe { & docker compose up -d --pull never }
            }
            Get-And-OpenUrl
        }
        { $_ -in @("0", "q", "Q") } {
            exit 0
        }
        default {
            Write-Host "Неизвестная команда."
        }
    }
}
