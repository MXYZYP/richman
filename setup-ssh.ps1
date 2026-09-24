# setup-ssh.ps1
# One-time SSH passwordless setup: generates a key and installs it on the server,
# so deploy-manual.ps1 no longer asks for a password.
# Run: powershell -ExecutionPolicy Bypass -File "setup-ssh.ps1"
# Only needed once. You will be prompted for the server password a single time.

$server = "root@101.200.189.252"
$sshDir = Join-Path $env:USERPROFILE ".ssh"
$key    = Join-Path $sshDir "id_ed25519"
$keyFwd = $key -replace '\\', '/'

New-Item -ItemType Directory -Force -Path $sshDir | Out-Null

if (-not (Test-Path $key)) {
  Write-Host "No SSH key found, generating ed25519 keypair..."
  ssh-keygen -t ed25519 -N "" -f $keyFwd
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Key generation failed"
    exit $LASTEXITCODE
  }
}
else {
  Write-Host "SSH key already exists: $keyFwd"
}

Write-Host "Installing public key on server (enter server password ONCE)..."
Get-Content ($key + ".pub") | ssh $server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
if ($LASTEXITCODE -ne 0) {
  Write-Error "Public key install failed; check server password/connectivity"
  exit $LASTEXITCODE
}
Write-Host "Public key installed on server."

$config  = Join-Path $sshDir "config"
$block = @"

Host 101.200.189.252
  User root
  IdentityFile $keyFwd
  ProxyCommand none
  ControlMaster no
"@

if (-not (Test-Path $config) -or -not (Select-String -Pattern "101.200.189.252" -Path $config -Quiet)) {
  Add-Content -Path $config -Value $block
  Write-Host "Wrote ~/.ssh/config (auto key + connection reuse)."
}
else {
  Write-Host "~/.ssh/config already contains this host, skipped."
}

Write-Host ""
Write-Host "Setup complete. Running deploy-manual.ps1 from now on will not require a password."
