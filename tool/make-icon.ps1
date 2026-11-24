# make-icon.ps1: the store icon, 256 x 256, mod/icon.png. The overlay in small: the trick's name in the
# overlay's face (Montserrat ExtraBold, the game's own font file) and the three pop grades in the default colours.
#
#   powershell -NoProfile -File tool/make-icon.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fontFile = Resolve-Path (Join-Path $here '..\..\ReSkate-src\External\fonts\Montserrat-ExtraBold.ttf')
$out = Join-Path $here '..\mod\icon.png'

Add-Type -AssemblyName System.Drawing
$fonts = New-Object System.Drawing.Text.PrivateFontCollection
$fonts.AddFontFile($fontFile)
$family = $fonts.Families[0]

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::FromArgb(255, 18, 20, 24))

function Rounded([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}
function Centred([string]$text, [float]$em, [float]$cx, [float]$top, $brush) {
    $font = New-Object System.Drawing.Font($family, $em, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $format = [System.Drawing.StringFormat]::GenericTypographic
    $w = $g.MeasureString($text, $font, 2000, $format).Width
    $g.DrawString($text, $font, $brush, ($cx - $w / 2), $top, $format)
    $font.Dispose()
}

$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 18, 20, 24))
Centred 'POP' 78 128 14 $white
Centred 'GRADER' 52 128 98 $white

# the three grades, as the overlay's badges: low, mid, high in the default colours
$grades = @(
    @{ t = 'L'; c = [System.Drawing.Color]::FromArgb(255, 198, 196, 12) },
    @{ t = 'M'; c = [System.Drawing.Color]::FromArgb(255, 10, 237, 27) },
    @{ t = 'H'; c = [System.Drawing.Color]::FromArgb(255, 215, 3, 3) }
)
$bw = 56; $bh = 50; $gap = 12
$x = ($size - (3 * $bw + 2 * $gap)) / 2
foreach ($gr in $grades) {
    $brush = New-Object System.Drawing.SolidBrush $gr.c
    $path = Rounded $x 176 $bw $bh 10
    $g.FillPath($brush, $path)
    Centred $gr.t 38 ($x + $bw / 2) 181 $dark
    $brush.Dispose(); $path.Dispose()
    $x += $bw + $gap
}

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "wrote $out"
