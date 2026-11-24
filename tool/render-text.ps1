# render-text.ps1: bake bitmap fonts for the overlay. The game bakes its own fonts once (17 / 22 / 44 px) and
# d:text stretches those bitmaps, and a plugin may reference at most 32 picture files in its life, so one picture per
# trick name is out. Instead: per font, two 512 x 512 sheets of glyphs (printable ASCII, 7 x 7 cells of 73 px, em 52
# px), white on transparent; the plugin draws text glyph by glyph with d:image's uv window and the glyph advances.
#
#   powershell -File tool/render-text.ps1
#
# Writes mod/text/<font>/sheet0.png, sheet1.png and manifest.json {em, cell, pad, line, sheets: [...],
# glyphs: {"A": {s, x, y, w, adv}}}, plus mod/text/fonts.json: [{name, folder}].

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..')
$fontDir = Join-Path $root '..\ReSkate-src\External\fonts'
$ownFontDir = Join-Path $here 'fonts'  # fonts this project brought itself (tool/fonts, each with its licence): looked in first
$outRoot = Join-Path $root 'mod\text'
$sheet = 512
$cols = 7
$cell = [math]::Floor($sheet / $cols)   # 73
$em = 48                                # the glyph em in pixels; the tallest line (Permanent Marker, 1.46 em) fits a cell
$pad = 6                                # pixels left of the pen in each cell, for glyphs that lean left

Add-Type -AssemblyName System.Drawing

$fontList = @(
    @{ name = 'Montserrat ExtraBold'; file = 'Montserrat-ExtraBold.ttf' },
    @{ name = 'Montserrat SemiBold'; file = 'Montserrat-SemiBold.ttf' },
    @{ name = 'Permanent Marker'; file = 'PermanentMarker-Regular.ttf' },
    @{ name = 'Anton'; file = 'Anton-Regular.ttf' },
    @{ name = 'Barlow Bold'; file = 'Barlow-Bold.ttf' }
)
# Only fonts whose licence lets the sheets be given away ship (mod/text/licences). A Windows font can be drawn the same
# way with  @{ name = 'Impact'; family = 'Impact' }  but its sheets must stay on your own machine.

function Slug([string]$t) {
    $x = $t.ToLowerInvariant() -replace '[^a-z0-9]+', '_'
    return $x.Trim('_')
}

$format = [System.Drawing.StringFormat]::GenericTypographic
$format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces

New-Item -ItemType Directory -Force $outRoot | Out-Null
# the old per-name pictures go
Get-ChildItem $outRoot -Directory | ForEach-Object { Get-ChildItem $_.FullName -Filter *.png | Where-Object { $_.Name -notmatch '^sheet\d+\.png$' } | Remove-Item -Force }
Get-ChildItem $outRoot -Filter *.png | Remove-Item -Force
if (Test-Path (Join-Path $outRoot 'manifest.json')) { Remove-Item (Join-Path $outRoot 'manifest.json') -Force }

$fontsIndex = @()
$private = New-Object System.Drawing.Text.PrivateFontCollection
$installed = New-Object System.Drawing.Text.InstalledFontCollection
$chars = 32..126 | ForEach-Object { [char]$_ }

foreach ($f in $fontList) {
    $family = $null
    $style = [System.Drawing.FontStyle]::Regular
    if ($f.file) {
        $path = Join-Path $ownFontDir $f.file
        if (-not (Test-Path $path)) { $path = Join-Path $fontDir $f.file }
        if (-not (Test-Path $path)) { Write-Warning "font file missing: $path"; continue }
        # the family this file brought: the collection keeps its families sorted by name, so the last one is not it
        $had = @($private.Families | ForEach-Object { $_.Name })
        $private.AddFontFile((Resolve-Path $path))
        $family = $private.Families | Where-Object { $had -notcontains $_.Name } | Select-Object -First 1
        if (-not $family) { Write-Warning "no new font family in $path"; continue }
        # a file that holds one weight only (Barlow-Bold.ttf is family Barlow, style Bold) has no Regular to draw
        if (-not $family.IsStyleAvailable($style)) { $style = [System.Drawing.FontStyle]::Bold }
    } else {
        $family = $installed.Families | Where-Object { $_.Name -eq $f.family } | Select-Object -First 1
        if (-not $family) { Write-Warning "Windows font not installed: $($f.family)"; continue }
        if ($f.style -eq 'Bold') { $style = [System.Drawing.FontStyle]::Bold }
    }
    $folder = Slug $f.name
    $outDir = Join-Path $outRoot $folder
    New-Item -ItemType Directory -Force $outDir | Out-Null

    $font = New-Object System.Drawing.Font($family, [float]$em, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $line = [math]::Ceiling($font.GetHeight(96))
    $perSheet = $cols * $cols
    $sheets = [math]::Ceiling($chars.Count / $perSheet)
    $bitmaps = @()
    $graphics = @()
    for ($s = 0; $s -lt $sheets; $s++) {
        $b = New-Object System.Drawing.Bitmap $sheet, $sheet, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($b)
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $bitmaps += $b; $graphics += $g
    }
    $glyphs = [ordered]@{}
    $i = 0
    foreach ($ch in $chars) {
        $s = [math]::Floor($i / $perSheet)
        $slot = $i % $perSheet
        $cx = ($slot % $cols) * $cell
        $cy = [math]::Floor($slot / $cols) * $cell
        $text = [string]$ch
        $adv = $graphics[$s].MeasureString($text, $font, 4096, $format).Width
        if ($ch -eq ' ') { $adv = $graphics[$s].MeasureString('n n', $font, 4096, $format).Width - $graphics[$s].MeasureString('nn', $font, 4096, $format).Width }
        # Keep a transparent gutter: some glyphs extend above their origin into the previous row.
        # Without clipping, those pixels appear as stray marks below another glyph at runtime.
        $clip = New-Object System.Drawing.RectangleF ([float]($cx + 1)), ([float]($cy + 1)), ([float]($cell - 2)), ([float]($cell - 2))
        $graphics[$s].SetClip($clip)
        $graphics[$s].DrawString($text, $font, [System.Drawing.Brushes]::White, $cx + $pad, $cy + 2, $format)
        $graphics[$s].ResetClip()
        # keyed by code point: a PowerShell hashtable's string keys are case-insensitive ("N" and "n" would collide)
        $glyphs[[string][int][char]$ch] = [ordered]@{ s = $s; x = $cx; y = $cy; w = $cell; adv = [math]::Round($adv, 2) }
        $i++
    }
    $sheetFiles = @()
    for ($s = 0; $s -lt $sheets; $s++) {
        $graphics[$s].Dispose()
        $file = "sheet$s.png"
        $bitmaps[$s].Save((Join-Path $outDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmaps[$s].Dispose()
        $sheetFiles += "text/$folder/$file"
    }
    $font.Dispose()
    $manifest = [ordered]@{ em = $em; cell = $cell; pad = $pad; line = $line; size = $sheet; sheets = $sheetFiles; glyphs = $glyphs }
    $json = ConvertTo-Json -Compress -Depth 4 -InputObject $manifest
    [System.IO.File]::WriteAllText((Join-Path $outDir 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding $false))
    $fontsIndex += [pscustomobject]@{ name = $f.name; folder = $folder }
    "$($f.name): $($chars.Count) glyphs on $sheets sheets -> text/$folder (line $line px)"
}

$idx = ConvertTo-Json -Compress -Depth 3 -InputObject @($fontsIndex)
[System.IO.File]::WriteAllText((Join-Path $outRoot 'fonts.json'), $idx, (New-Object System.Text.UTF8Encoding $false))
"fonts.json: $($fontsIndex.Count) fonts"
