<#
.SYNOPSIS
    Reactive Lab — runner de PowerShell para comparar Spring MVC vs WebFlux.

.DESCRIPTION
    Corre cada app EN AISLAMIENTO (la otra apagada) y lanza k6 desde dentro
    de la red de compose, para que el tráfico de carga no atraviese el proxy
    de puertos de Docker Desktop.

    Mientras k6 corre, muestrea jvm.threads.live vía actuator. Ese número es
    la explicación causal del resultado: MVC necesita un hilo por request en
    vuelo, WebFlux no.

.EXAMPLE
    .\run-lab.ps1                      # ciclo completo: ambas apps + comparación
    .\run-lab.ps1 -Action test -Target mvc
    .\run-lab.ps1 -Action compare      # recompara resultados ya guardados
    .\run-lab.ps1 -Action down
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'test', 'compare', 'down', 'status')]
    [string]$Action = 'all',

    [ValidateSet('mvc', 'flux', 'both')]
    [string]$Target = 'both'
)

# OJO: NO usar 'Stop' acá. Docker escribe mensajes de progreso normales en
# stderr (" Container lab-mvc  Stopping"), y con ErrorActionPreference=Stop
# PowerShell los convierte en NativeCommandError y aborta el script aunque
# el comando haya salido con 0. Se verifica $LASTEXITCODE explícitamente.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

# Un solo lugar donde vive el mapeo target -> perfil / contenedor / puerto.
$APPS = @{
    mvc  = @{ Profile = 'mvc';  Container = 'lab-mvc';     Port = 8081; Label = 'SPRING MVC (Tomcat / JDBC)' }
    flux = @{ Profile = 'flux'; Container = 'lab-webflux'; Port = 8082; Label = 'SPRING WEBFLUX (Netty / R2DBC)' }
}

# Ventana del escenario slow_io dentro de la corrida de k6, en segundos.
# Es el tramo que aísla el modelo de ejecución.
$SLOW_IO_START = 125
$SLOW_IO_END = 185

function Write-Step { param([string]$Message) Write-Host "[LAB] $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "[OK]  $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[!]   $Message" -ForegroundColor Yellow }

function Assert-Docker {
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "El daemon de Docker no responde. Abre Docker Desktop y espera a que termine de arrancar."
    }
}

function Assert-Images {
    foreach ($image in @('reactive-lab/mvc-app:1.0.0', 'reactive-lab/webflux-app:1.0.0')) {
        docker image inspect $image 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Falta la imagen $image. Corre primero: .\run-lab.ps1 -Action all"
        }
    }
}

function Wait-Healthy {
    param([string]$Container, [int]$TimeoutSec = 180)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $status = docker inspect $Container --format '{{.State.Health.Status}}' 2>$null
        if ($status -eq 'healthy') { return }
        if ($status -eq 'unhealthy') { throw "$Container quedó unhealthy." }
        Start-Sleep -Seconds 3
    }
    throw "$Container no llegó a healthy en $TimeoutSec s."
}

function Start-App {
    param([string]$Key)

    $app = $APPS[$Key]

    # Aislamiento: apagar la otra app para que no compita por CPU ni por
    # conexiones a MySQL. Sin esto la medición no es limpia.
    foreach ($other in $APPS.Keys) {
        if ($other -ne $Key) {
            $otherProfile = $APPS[$other].Profile
            $otherService = if ($other -eq 'mvc') { 'mvc-app' } else { 'webflux-app' }
            docker compose --profile $otherProfile stop $otherService 2>&1 | Out-Null
        }
    }

    Write-Step "Levantando $($app.Label)..."
    $profileName = $app.Profile
    docker compose --profile $profileName up -d 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Falló 'docker compose --profile $profileName up -d' (exit $LASTEXITCODE)." }

    Wait-Healthy -Container $app.Container
    Write-Ok "$($app.Container) healthy en puerto $($app.Port)"
}

function Stop-Apps {
    docker compose --profile mvc stop mvc-app 2>&1 | Out-Null
    docker compose --profile flux stop webflux-app 2>&1 | Out-Null
}

function Start-ThreadSampler {
    param([int]$Port, [int]$DurationSec = 260)

    # Job en background que emite cada muestra al stream de salida (no las
    # acumula en una variable) para que Receive-Job siga funcionando
    # después de Stop-Job.
    Start-Job -ScriptBlock {
        param($p, $dur)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($sw.Elapsed.TotalSeconds -lt $dur) {
            try {
                $m = Invoke-RestMethod -Uri "http://localhost:$p/actuator/metrics/jvm.threads.live" -TimeoutSec 3
                [pscustomobject]@{
                    t       = [math]::Round($sw.Elapsed.TotalSeconds, 0)
                    threads = [int]$m.measurements[0].value
                }
            }
            catch { }
            Start-Sleep -Milliseconds 2000
        }
    } -ArgumentList $Port, $DurationSec
}

function Invoke-LoadTest {
    param([string]$Key)

    $app = $APPS[$Key]

    Write-Host ""
    Write-Host ("=" * 74) -ForegroundColor Blue
    Write-Host "  CARGA CONTRA: $($app.Label)" -ForegroundColor Blue
    Write-Host ("=" * 74) -ForegroundColor Blue
    Write-Host ""

    $sampler = Start-ThreadSampler -Port $app.Port

    try {
        # k6 corre dentro de la red de compose y resuelve el hostname del
        # servicio, así que el tráfico no sale al host.
        docker compose run --rm k6 run --quiet --env "TARGET=$Key" /scripts/load-test.js
        $k6Exit = $LASTEXITCODE
    }
    finally {
        Stop-Job $sampler -ErrorAction SilentlyContinue
        $samples = @(Receive-Job $sampler -ErrorAction SilentlyContinue)
        Remove-Job $sampler -Force -ErrorAction SilentlyContinue
    }

    if ($samples.Count -gt 0) {
        $csv = ".\results\threads-${Key}.csv"

        # Select-Object explícito: Receive-Job adorna los objetos con
        # PSComputerName, RunspaceId y PSShowComputerName, y Export-Csv las
        # escribiría como columnas. Solo queremos la serie temporal.
        $samples | Select-Object t, threads | Export-Csv -NoTypeInformation -Path $csv

        $peak = ($samples | Measure-Object -Property threads -Maximum).Maximum
        $idle = ($samples | Where-Object { $_.t -lt 18 } | Measure-Object -Property threads -Minimum).Minimum
        $slowWindow = $samples | Where-Object { $_.t -ge $SLOW_IO_START -and $_.t -le $SLOW_IO_END }
        $slowPeak = if ($slowWindow) { ($slowWindow | Measure-Object -Property threads -Maximum).Maximum } else { 'n/d' }

        Write-Host "  HILOS VIVOS EN LA JVM" -ForegroundColor Cyan
        Write-Host "    en reposo                  : $idle"
        Write-Host "    pico global                : $peak"
        Write-Host "    pico durante slow_io       : $slowPeak"
        Write-Host "    serie completa             : $csv  ($($samples.Count) muestras)"
        Write-Host ""
    }
    else {
        Write-Warn "No se pudieron muestrear hilos (actuator no respondió)."
    }

    if ($k6Exit -ne 0) {
        Write-Warn "k6 salió con código $k6Exit — probablemente un threshold incumplido. Los resultados siguen siendo válidos."
    }
}

function Get-ScenarioRow {
    param($Metrics, [string]$Scenario)

    $dur = $Metrics."http_req_duration{scenario:$Scenario}"
    $fail = $Metrics."http_req_failed{scenario:$Scenario}"
    if (-not $dur) { return $null }

    [pscustomobject]@{
        avg = [math]::Round($dur.values.avg, 0)
        p95 = [math]::Round($dur.values.'p(95)', 0)
        p99 = [math]::Round($dur.values.'p(99)', 0)
        max = [math]::Round($dur.values.max, 0)
        err = if ($fail) { [math]::Round($fail.values.rate * 100, 2) } else { 0 }
    }
}

function Show-Comparison {
    $mvcPath = '.\results\results-mvc.json'
    $fluxPath = '.\results\results-flux.json'

    if (-not (Test-Path $mvcPath) -or -not (Test-Path $fluxPath)) {
        Write-Warn "Faltan resultados de una de las dos apps. Corre: .\run-lab.ps1 -Action all"
        return
    }

    $mvc = Get-Content $mvcPath -Raw | ConvertFrom-Json
    $flux = Get-Content $fluxPath -Raw | ConvertFrom-Json

    Write-Host ""
    Write-Host ("=" * 74) -ForegroundColor Cyan
    Write-Host "  COMPARACION  —  MVC  vs  WEBFLUX" -ForegroundColor Cyan
    Write-Host ("=" * 74) -ForegroundColor Cyan

    # Validez primero: si k6 no generó la carga pedida, nada de lo de abajo
    # es comparable y hay que decirlo antes de mostrar un solo número.
    $dropMvc = if ($mvc.metrics.dropped_iterations) { $mvc.metrics.dropped_iterations.values.count } else { 0 }
    $dropFlux = if ($flux.metrics.dropped_iterations) { $flux.metrics.dropped_iterations.values.count } else { 0 }

    Write-Host ""
    if ($dropMvc -gt 0 -or $dropFlux -gt 0) {
        Write-Warn "dropped_iterations: mvc=$dropMvc flux=$dropFlux — k6 no alcanzó a generar la carga. Corrida NO comparable."
    }
    else {
        Write-Ok "dropped_iterations = 0 en ambas: k6 generó toda la carga pedida."
    }

    $scenarios = @(
        @{ Name = 'baseline'; Endpoint = '/api/catalogs' },
        @{ Name = 'stress';   Endpoint = '/api/catalogs' },
        @{ Name = 'slow_io';  Endpoint = '/slow' },
        @{ Name = 'spike';    Endpoint = '/api/catalogs' }
    )

    foreach ($metric in @('avg', 'p95', 'p99', 'max', 'err')) {
        $unit = if ($metric -eq 'err') { '%' } else { 'ms' }
        Write-Host ""
        Write-Host "  $($metric.ToUpper()) ($unit)" -ForegroundColor White
        Write-Host ("  " + 'escenario'.PadRight(11) + 'endpoint'.PadRight(17) + 'MVC'.PadLeft(10) + 'WEBFLUX'.PadLeft(10) + 'ganador'.PadLeft(12))
        Write-Host ("  " + '-' * 68)

        foreach ($sc in $scenarios) {
            $m = Get-ScenarioRow -Metrics $mvc.metrics -Scenario $sc.Name
            $f = Get-ScenarioRow -Metrics $flux.metrics -Scenario $sc.Name
            if (-not $m -or -not $f) { continue }

            $mv = $m.$metric
            $fv = $f.$metric

            # Menor es mejor en todas estas métricas.
            $winner = if ($mv -eq $fv) { '=' }
            elseif ($mv -lt $fv) { 'MVC' }
            else { 'WebFlux' }

            $color = switch ($winner) {
                'MVC' { 'Yellow' }
                'WebFlux' { 'Magenta' }
                default { 'Gray' }
            }

            Write-Host ("  " + $sc.Name.PadRight(11) + $sc.Endpoint.PadRight(17) + "$mv".PadLeft(10) + "$fv".PadLeft(10)) -NoNewline
            Write-Host ("$winner".PadLeft(12)) -ForegroundColor $color
        }
    }

    # Hilos: la explicación causal de todo lo anterior.
    Write-Host ""
    Write-Host "  HILOS VIVOS EN LA JVM (pico)" -ForegroundColor White
    Write-Host ("  " + '-' * 68)
    foreach ($key in @('mvc', 'flux')) {
        $csv = ".\results\threads-${key}.csv"
        if (Test-Path $csv) {
            $rows = Import-Csv $csv
            $peak = ($rows | ForEach-Object { [int]$_.threads } | Measure-Object -Maximum).Maximum
            $window = $rows | Where-Object { [int]$_.t -ge $SLOW_IO_START -and [int]$_.t -le $SLOW_IO_END }
            $slowPeak = if ($window) { ($window | ForEach-Object { [int]$_.threads } | Measure-Object -Maximum).Maximum } else { 'n/d' }
            Write-Host ("  " + $key.PadRight(28) + "pico global: $peak".PadRight(22) + "pico en slow_io: $slowPeak")
        }
    }

    Write-Host ""
    Write-Host ("=" * 74) -ForegroundColor Cyan
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────

Assert-Docker
New-Item -ItemType Directory -Path .\results -Force | Out-Null

switch ($Action) {

    'status' {
        docker compose ps --format "{{.Name}}`t{{.Status}}"
    }

    'down' {
        Write-Step "Deteniendo y eliminando contenedores..."
        docker compose --profile mvc --profile flux --profile load down 2>&1 | Out-Null
        Write-Ok "Listo. (El volumen de MySQL se conserva; usa 'docker compose down -v' para borrarlo.)"
    }

    'compare' {
        Show-Comparison
    }

    'test' {
        Assert-Images
        $keys = if ($Target -eq 'both') { @('mvc', 'flux') } else { @($Target) }
        foreach ($k in $keys) {
            Start-App -Key $k
            Invoke-LoadTest -Key $k
        }
        if ($Target -eq 'both') { Show-Comparison }
    }

    'all' {
        Write-Step "Construyendo imágenes (la primera vez tarda varios minutos)..."
        docker compose --profile mvc --profile flux build 2>&1 | Select-String -Pattern 'BUILD SUCCESSFUL|ERROR|FAILED'
        Write-Ok "Imágenes listas."

        foreach ($k in @('mvc', 'flux')) {
            Start-App -Key $k
            Invoke-LoadTest -Key $k
        }

        Stop-Apps
        Show-Comparison
        Write-Step "Para limpiar: .\run-lab.ps1 -Action down"
    }
}
