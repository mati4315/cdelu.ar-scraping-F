# ============================================================
#  deploy.ps1  —  Sube archivos al servidor de Hostinger
#  Uso:  .\deploy.ps1
#        .\deploy.ps1 -File helpers.js        (un solo archivo)
#        .\deploy.ps1 -IncludeCookies         (incluye cookies.json)
#        .\deploy.ps1 -IncludeEnv             (incluye .env)
# ============================================================

param(
    [string]$File = "",          # Si se pasa, solo sube ese archivo
    [switch]$IncludeCookies,     # Incluir cookies.json (sensible)
    [switch]$IncludeEnv,         # Incluir .env (sensible)
    [switch]$DryRun              # Solo muestra qué subiría, sin subir
)

$SSH_KEY   = "$env:USERPROFILE\.ssh\hostinger_scraper"
$SSH_USER  = "u692901087"
$SSH_HOST  = "195.35.41.78"
$SSH_PORT  = "65002"
$REMOTE    = "/home/u692901087/domains/bot.cdelu.io/nodejs"
$LOCAL     = $PSScriptRoot

# Archivos que se suben SIEMPRE (no sensibles)
$FILES = @(
    "app.js",
    "scraper.js",
    "helpers.js",
    "firebase.js",
    "config.js",
    "db.js",
    "logger.js",
    "tls.js",
    "server.js",
    "settings.js",
    "settings.schema.js",
    "run_scraper.php",
    "package.json"
)

# ── Función para subir un archivo ───────────────────────────
function Upload-File($localFile) {
    $localPath  = Join-Path $LOCAL $localFile
    $remotePath = "${SSH_USER}@${SSH_HOST}:${REMOTE}/${localFile}"

    if (-not (Test-Path $localPath)) {
        Write-Host "  [SKIP] No encontrado: $localFile" -ForegroundColor Yellow
        return
    }

    if ($DryRun) {
        Write-Host "  [DRY]  $localFile → $remotePath" -ForegroundColor Cyan
        return
    }

    Write-Host "  [UP]   $localFile..." -ForegroundColor White -NoNewline
    $result = & scp.exe -i $SSH_KEY -P $SSH_PORT $localPath $remotePath 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host " OK" -ForegroundColor Green
    } else {
        Write-Host " ERROR: $result" -ForegroundColor Red
    }
}

# ── Header ─────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Deploy → bot.cdelu.io (Hostinger)" -ForegroundColor Cyan
Write-Host "  Host: ${SSH_HOST}:${SSH_PORT}" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Si se pasó un archivo específico ────────────────────────
if ($File -ne "") {
    Write-Host "Modo: archivo específico → $File" -ForegroundColor Magenta
    Upload-File $File
    Write-Host ""
    Write-Host "Listo." -ForegroundColor Green
    exit 0
}

# ── Subir archivos principales ──────────────────────────────
Write-Host "Subiendo archivos del proyecto..." -ForegroundColor Magenta
foreach ($f in $FILES) {
    Upload-File $f
}

# ── Archivos sensibles (opcionales) ─────────────────────────
if ($IncludeCookies) {
    Write-Host ""
    Write-Host "Subiendo cookies.json..." -ForegroundColor Magenta
    Upload-File "cookies.json"
}

if ($IncludeEnv) {
    Write-Host ""
    Write-Host "Subiendo .env (desde .env.hostinger)..." -ForegroundColor Magenta
    $localEnv  = Join-Path $LOCAL ".env.hostinger"
    $remoteEnv = "${SSH_USER}@${SSH_HOST}:${REMOTE}/.env"
    if (-not $DryRun) {
        Write-Host "  [UP]   .env.hostinger → .env..." -ForegroundColor White -NoNewline
        $result = & scp.exe -i $SSH_KEY -P $SSH_PORT $localEnv $remoteEnv 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host " OK" -ForegroundColor Green }
        else { Write-Host " ERROR: $result" -ForegroundColor Red }
    } else {
        Write-Host "  [DRY]  .env.hostinger → $remoteEnv" -ForegroundColor Cyan
    }
}

# ── Reiniciar el proceso Node si está corriendo como Passenger ──
Write-Host ""
Write-Host "Tocando tmp/restart.txt para reiniciar Passenger..." -ForegroundColor Magenta
if (-not $DryRun) {
    $touchCmd = "touch /home/u692901087/domains/bot.cdelu.io/nodejs/tmp/restart.txt"
    & ssh.exe -o StrictHostKeyChecking=no -i $SSH_KEY -p $SSH_PORT "${SSH_USER}@${SSH_HOST}" $touchCmd
    if ($LASTEXITCODE -eq 0) { Write-Host "  [OK]  Passenger reiniciará en el próximo request." -ForegroundColor Green }
    else { Write-Host "  [WARN] No se pudo tocar restart.txt (puede no ser crítico)." -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Deploy completado." -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
