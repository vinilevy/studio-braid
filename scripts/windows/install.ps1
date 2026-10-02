# ==============================================================================
# Studio Braid - Instalador Automatizado para Windows
# ==============================================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Instalador do Studio Braid"

function Write-Step {
    param([string]$Message)
    Write-Host "`n[+] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "    ✓ $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    ! $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "    ✗ $Message" -ForegroundColor Red
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host @"
======================================================================
                     STUDIO BRAID - INSTALAÇÃO WINDOWS
        (Screen Studio Bridge - Da gravação à edição no DaVinci)
======================================================================
"@ -ForegroundColor Magenta

# 1. Atualizar PATH da sessão atual
function Refresh-EnvPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}
Refresh-EnvPath

# 2. Verificar / Instalar Node.js
Write-Step "Verificando Node.js..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Warn "Node.js não encontrado no PATH. Tentando instalar via winget..."
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        & winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        Refresh-EnvPath
    } else {
        Write-Warn "Winget não disponível. Baixando instalador oficial do Node.js LTS..."
        $nodeMsi = "$env:TEMP\nodejs-lts.msi"
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi" -OutFile $nodeMsi
        Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn" -Wait
        Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
        Refresh-EnvPath
    }
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
}

if ($nodeCmd) {
    $nodeVersion = & node -v
    Write-Success "Node.js pronto: $nodeVersion"
} else {
    Write-Err "Node.js não pôde ser instalado automaticamente. Por favor, instale em https://nodejs.org/"
    Pause
    Exit 1
}

# 3. Verificar / Instalar FFmpeg e FFprobe
Write-Step "Verificando FFmpeg e FFprobe..."
$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
    Write-Warn "FFmpeg não encontrado. Tentando instalar via winget..."
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        & winget install Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
        Refresh-EnvPath
        $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    }
    
    if (-not $ffmpegCmd) {
        Write-Warn "Baixando pacote FFmpeg essentials portátil..."
        $binDir = Join-Path $ProjectRoot "bin"
        if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir | Out-Null }
        
        $ffmpegZip = "$env:TEMP\ffmpeg-release-essentials.zip"
        $ffmpegExtract = "$env:TEMP\ffmpeg-extract"
        
        try {
            Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffmpegZip
            Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegExtract -Force
            $binSource = Get-ChildItem -Path $ffmpegExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
            if ($binSource) {
                Copy-Item -Path (Join-Path $binSource.Directory.FullName "*") -Destination $binDir -Recurse -Force
                $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
                if ($userPath -notlike "*$binDir*") {
                    [System.Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
                }
                Refresh-EnvPath
            }
        } catch {
            Write-Warn "Não foi possível baixar o FFmpeg automaticamente: $_"
        } finally {
            Remove-Item $ffmpegZip -Force -ErrorAction SilentlyContinue
            Remove-Item $ffmpegExtract -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpegCmd) {
    Write-Success "FFmpeg pronto."
} else {
    Write-Warn "FFmpeg não detectado no PATH. O aplicativo funcionará, mas converter vídeos exigirá o FFmpeg instalado."
}

# 4. Instalar dependências e compilar
Write-Step "Instalando dependências do projeto..."
if (Test-Path "package-lock.json") {
    & npm install
} else {
    & npm install
}
Write-Success "Dependências instaladas."

Write-Step "Compilando código do Studio Braid..."
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Err "Falha na compilação do projeto."
    Pause
    Exit 1
}
Write-Success "Build compilado com sucesso."

# 5. Criar Atalho na Área de Trabalho e na Inicialização (Startup)
Write-Step "Configurando atalhos de inicialização rápida..."

$WshShell = New-Object -ComObject WScript.Shell
$LauncherVbs = Join-Path $ScriptDir "StudioBraid-Launcher.vbs"
$IconFile = Join-Path $ProjectRoot "assets\icon.ico"

# Atalho no Desktop
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$DesktopShortcutPath = Join-Path $DesktopPath "Studio Braid.lnk"
$Shortcut = $WshShell.CreateShortcut($DesktopShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$LauncherVbs`""
$Shortcut.WorkingDirectory = $ProjectRoot
if (Test-Path $IconFile) {
    $Shortcut.IconLocation = "$IconFile, 0"
}
$Shortcut.Description = "Studio Braid - Exportador Screen Studio"
$Shortcut.Save()
Write-Success "Atalho criado na Área de Trabalho: Studio Braid.lnk"

# Atalho no Startup (Inicia com o Windows)
$StartupPath = [Environment]::GetFolderPath("Startup")
$StartupShortcutPath = Join-Path $StartupPath "Studio Braid.lnk"
$StartupShortcut = $WshShell.CreateShortcut($StartupShortcutPath)
$StartupShortcut.TargetPath = "wscript.exe"
$StartupShortcut.Arguments = "`"$LauncherVbs`""
$StartupShortcut.WorkingDirectory = $ProjectRoot
if (Test-Path $IconFile) {
    $StartupShortcut.IconLocation = "$IconFile, 0"
}
$StartupShortcut.Description = "Studio Braid - Inicialização Automática com o Windows"
$StartupShortcut.Save()
Write-Success "Inicialização automática configurada no Windows (Startup)."

# 6. Iniciar o Studio Braid agora mesmo
Write-Step "Iniciando o Studio Braid..."
Start-Process "wscript.exe" -ArgumentList "`"$LauncherVbs`""

Write-Host @"

======================================================================
               🎉 INSTALAÇÃO CONCLUÍDA COM SUCESSO!
======================================================================
1. O Studio Braid foi iniciado e a interface abriu no seu navegador!
2. Sempre que você ligar o computador, ele abrirá sozinho.
3. Você também tem um ícone 'Studio Braid' na Área de Trabalho
   para abrir a qualquer momento sem precisar ver nenhuma tela preta!
4. Para parar o servidor quando quiser: scripts\windows\stop.bat
======================================================================
"@ -ForegroundColor Green

Write-Host "Pressione qualquer tecla para fechar este instalador..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
