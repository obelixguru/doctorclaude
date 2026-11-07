# Deploys the Dr Claude v4.0 edge functions to Obelix-Projects.
#
# Order matters: run supabase/migrations/20261106_v40.sql, then 20261107_v40_forecast.sql, then
# 20261107_v40_named_doses.sql, in the SQL editor FIRST. The functions read the new columns, and without
# them every analysis would lose its readings and its meals. Without the third one doses are still named
# and remembered, but the dose score stays as it was. Without 20261107_v40_domino_passes.sql and the door
# (supabase/functions-nueve/mechabetics-domino, deployed apart, to the Nueve project), DeepSeek answers alone.
#
# Usage, from the repository root:
#   npx -y supabase@latest login       (once: opens the browser, the token stays on this machine)
#   .\scripts\deploy-v4.ps1
#
# The server-side bundler (--use-api) means no Docker and no local Deno are needed.

$ErrorActionPreference = "Stop"
$ref = "vzafttfgrxpjdraveihh"
# The new function first: the analysis calls it. Then the ones that decide, then the ones that read.
$functions = @(
  "mechabetics-learn",
  "mechabetics-coach",
  "mechabetics-ask",
  "mechabetics-scan",
  "mechabetics-meals",
  "mechabetics-history",
  "mechabetics-profile",
  "mechabetics-monitor",
  "mechabetics-autotune",
  "mechabetics-diet"
)
# These two run without JWT verification today, and the monitor is what the cron job calls. Deploying
# them without the flag would silently turn verification on, and the server-side alerts could stop.
$noJwt = @("mechabetics-monitor", "mechabetics-diet")
foreach ($f in $functions) {
  Write-Host "--- $f"
  $extra = if ($noJwt -contains $f) { @("--no-verify-jwt") } else { @() }
  npx -y supabase@latest functions deploy $f --remote=$ref --use-api @extra
  if ($LASTEXITCODE -ne 0) { throw "Deployment stopped at $f" }
}
Write-Host "Done."
