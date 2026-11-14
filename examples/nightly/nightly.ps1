# A nightly comparison with a trend report, for a Windows scheduled task. Keep it next to cmtk.yaml.
# Credentials come from environment variables, never from this file.
Set-Location -Path $PSScriptRoot

cmtk compare --dated
$code = $LASTEXITCODE

cmtk trend --mode compare

exit $code
