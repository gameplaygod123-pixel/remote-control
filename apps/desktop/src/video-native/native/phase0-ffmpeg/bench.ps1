# Phase 0-B de-risk (compiler-free) — reproducible ffmpeg bench.
# Proves DXGI Desktop Duplication (ddagrab) + hardware H.264/HEVC encode (NVENC / MF)
# on the real machine WITHOUT any MSVC/Windows SDK. See RESULTS.md for measured numbers.
#
# Usage (portable ffmpeg, no install/admin — get a build with ddagrab + nvenc + mf,
# e.g. BtbN "ffmpeg-master-latest-win64-gpl"):
#   powershell -File bench.ps1 -Ff C:\path\to\ffmpeg.exe
param([Parameter(Mandatory=$true)][string]$Ff)

if (-not (Test-Path $Ff)) { Write-Error "ffmpeg not found at $Ff"; exit 1 }
Write-Output "ffmpeg: $Ff"
& $Ff -hide_banner -filters   2>$null | Select-String "ddagrab"
& $Ff -hide_banner -encoders  2>$null | Select-String "h264_mf|h264_nvenc|hevc_nvenc|hevc_mf"

# ---- A) capture proof + native resolution ----
Write-Output "`n=== A) ddagrab capture probe (native resolution) ==="
& $Ff -hide_banner -loglevel verbose -filter_complex "ddagrab=output_idx=0:framerate=60" -t 1 -f null - 2>&1 |
  Select-String "Opened dxgi output|Probed .* frame format"

# ---- B) encoder throughput matrix (synthetic source, max-speed) ----
$N = 600
function Bench($name,$w,$h,$enc){
  $out = & $Ff -hide_banner -f lavfi -i "testsrc2=size=${w}x${h}:rate=60" -frames:v $N @enc -f null - -benchmark 2>&1
  $b = ($out | Select-String "rtime=") -replace ".*rtime=","" -replace "s.*",""
  if($b){ $rt=[double]$b; Write-Output ("{0,-12} {1}x{2}  per-frame={3,6} ms  throughput={4,5} fps ({5:N1}x realtime)" -f $name,$w,$h,[math]::Round($rt*1000/$N,2),[math]::Round($N/$rt,0),($N/$rt/60)) }
  else { Write-Output ("{0,-12} {1}x{2}  FAILED" -f $name,$w,$h) }
}
$nvLL = @("-preset","p1","-tune","ull","-rc","cbr","-b:v","30M","-bf","0","-g","120")
Write-Output "`n=== B) encoder throughput (synthetic, max-speed; NOTE CPU source handicaps nvenc's upload) ==="
foreach($res in @(@(1920,1080),@(2560,1440))){
  Bench "h264_nvenc" $res[0] $res[1] (@("-c:v","h264_nvenc")+$nvLL)
  Bench "h264_mf"    $res[0] $res[1] @("-c:v","h264_mf","-b:v","30M")
  Bench "hevc_nvenc" $res[0] $res[1] (@("-c:v","hevc_nvenc")+$nvLL)
}

# ---- C) realistic ddagrab GPU-capture -> encoder, realtime (the production path) ----
function RT($name,$graph,$enc){
  $out = & $Ff -hide_banner -filter_complex $graph -t 5 @enc -f null - -benchmark 2>&1
  $f = ($out | Select-String "^frame=" | Select-Object -Last 1) -replace '\s+',' '
  $u = ($out | Select-String "bench: utime")
  Write-Output ("{0,-32} {1}  {2}" -f $name,$f,$u)
}
Write-Output "`n=== C) ddagrab GPU capture -> encoder, realtime 5 s (utime = CPU cost; lower = more GPU zero-copy) ==="
RT "1440p -> h264_nvenc (zerocopy)" "ddagrab=output_idx=0:framerate=60" (@("-c:v","h264_nvenc")+$nvLL)
RT "1440p -> hevc_nvenc (zerocopy)" "ddagrab=output_idx=0:framerate=60" (@("-c:v","hevc_nvenc")+$nvLL)
RT "1440p -> h264_mf (hwdownload)"  "ddagrab=output_idx=0:framerate=60,hwdownload,format=bgra" @("-c:v","h264_mf","-b:v","30M")

# ---- D) decodable-file proof ----
Write-Output "`n=== D) decodable proof: encode 2 s to file (open in any player / ffprobe) ==="
& $Ff -hide_banner -loglevel error -filter_complex "ddagrab=output_idx=0:framerate=60" -t 2 -c:v h264_nvenc @nvLL "$PSScriptRoot\cap.mp4"
Write-Output "wrote $PSScriptRoot\cap.mp4"
