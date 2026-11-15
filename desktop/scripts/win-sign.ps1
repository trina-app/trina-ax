# Signs one file with Microsoft Artifact Signing and checks the result (called by ./win-sign.ts for every file
# electron-builder signs; docs/RELEASE-CI.md 11장). Needs the ArtifactSigning module (the release job installs a pinned
# version) and an Azure CLI sign-in (azure/login with OIDC). Only the Azure CLI credential is tried: no secret in the
# environment, no managed identity, no browser prompt.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Endpoint,
  [Parameter(Mandatory = $true)][string]$Account,
  [Parameter(Mandatory = $true)][string]$CertificateProfile
)
$ErrorActionPreference = 'Stop'

$params = @{
  Endpoint                            = $Endpoint
  CodeSigningAccountName              = $Account
  CertificateProfileName              = $CertificateProfile
  Files                               = $Path
  FileDigest                          = 'SHA256'
  TimestampRfc3161                    = 'http://timestamp.acs.microsoft.com'
  TimestampDigest                     = 'SHA256'
  ExcludeEnvironmentCredential        = $true
  ExcludeWorkloadIdentityCredential   = $true
  ExcludeManagedIdentityCredential    = $true
  ExcludeSharedTokenCacheCredential   = $true
  ExcludeVisualStudioCredential       = $true
  ExcludeVisualStudioCodeCredential   = $true
  ExcludeAzureCliCredential           = $false
  ExcludeAzurePowerShellCredential    = $true
  ExcludeAzureDeveloperCliCredential  = $true
  ExcludeInteractiveBrowserCredential = $true
}
Invoke-ArtifactSigning @params

# a signature Windows trusts, with a timestamp (it stays valid after the short-lived certificate expires)
$sig = Get-AuthenticodeSignature -LiteralPath $Path
if ($sig.Status -ne 'Valid') { throw "signature of $Path is $($sig.Status): $($sig.StatusMessage)" }
if ($null -eq $sig.TimeStamperCertificate) { throw "signature of $Path has no timestamp" }
Write-Host "signed: $Path ($($sig.SignerCertificate.Subject))"
