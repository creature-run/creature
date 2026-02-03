/**
 * Windows Code Signing Configuration for Azure Trusted Signing.
 * 
 * Based on: https://www.electronforge.io/guides/code-signing/code-signing-windows#using-azure-trusted-signing
 *
 * Required environment variables (set in CI workflow):
 * - SIGNTOOL_PATH: Path to signtool.exe from Windows SDK
 * - AZURE_CODE_SIGNING_DLIB: Path to Azure.CodeSigning.Dlib.dll
 * - AZURE_METADATA_JSON: Path to metadata.json with Azure signing config
 * - AZURE_TENANT_ID: Azure AD tenant ID (for DefaultAzureCredential)
 * - AZURE_CLIENT_ID: Azure AD client/app ID
 * - AZURE_CLIENT_SECRET: Azure AD client secret
 */

import type { WindowsSignOptions } from '@electron/packager';
import type { HASHES } from '@electron/windows-sign/dist/esm/types';

// Check if Windows signing is configured
const hasWindowsSigningConfig = !!(
  process.env.SIGNTOOL_PATH &&
  process.env.AZURE_CODE_SIGNING_DLIB &&
  process.env.AZURE_METADATA_JSON
);

/**
 * Windows signing configuration for Azure Trusted Signing.
 * Returns undefined if required environment variables are not set,
 * which allows the build to proceed without signing (for local dev).
 */
export const windowsSign: WindowsSignOptions | undefined = hasWindowsSigningConfig
  ? {
      // Path to signtool.exe from Windows SDK
      signToolPath: process.env.SIGNTOOL_PATH!,

      // Azure Trusted Signing params - /v and /debug for verbose logging
      signWithParams: `/v /debug /dlib ${process.env.AZURE_CODE_SIGNING_DLIB} /dmdf ${process.env.AZURE_METADATA_JSON}`,

      // RFC 3161 timestamp server for Azure Trusted Signing
      timestampServer: 'http://timestamp.acs.microsoft.com',

      // IMPORTANT: Must specify sha256 - Azure Trusted Signing doesn't support SHA1
      hashes: ['sha256' as HASHES],
    }
  : undefined;

// Log signing status at module load time
if (hasWindowsSigningConfig) {
  console.log('[WindowsSign] Azure Trusted Signing configured');
  console.log('[WindowsSign] SignTool:', process.env.SIGNTOOL_PATH);
  console.log('[WindowsSign] DLib:', process.env.AZURE_CODE_SIGNING_DLIB);
  console.log('[WindowsSign] Metadata:', process.env.AZURE_METADATA_JSON);
} else if (process.platform === 'win32') {
  console.log('[WindowsSign] Windows signing not configured - building unsigned');
}
