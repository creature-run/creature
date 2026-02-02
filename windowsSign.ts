/**
 * Windows Code Signing Configuration for Azure Trusted Signing.
 *
 * This module exports a windowsSign configuration object that is used by
 * Electron Packager and @electron-forge/maker-squirrel to sign Windows
 * executables using Azure Trusted Signing.
 *
 * Required environment variables (set in CI workflow):
 * - SIGNTOOL_PATH: Path to signtool.exe from Windows SDK
 * - AZURE_CODE_SIGNING_DLIB: Path to Azure.CodeSigning.Dlib.dll
 * - AZURE_METADATA_JSON: Path to metadata.json with Azure signing config
 * - AZURE_TENANT_ID: Azure AD tenant ID (for DefaultAzureCredential)
 * - AZURE_CLIENT_ID: Azure AD client/app ID
 * - AZURE_CLIENT_SECRET: Azure AD client secret
 *
 * The signing is performed using Azure Trusted Signing's signtool integration
 * which uses DefaultAzureCredential for authentication.
 */

import type { WindowsSignOptions } from '@electron/packager';

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

      // Custom signtool parameters for Azure Trusted Signing
      // Uses the /dlib and /dmdf flags to integrate with Azure's signing service
      signWithParams: [
        '/v',                                              // Verbose output
        '/debug',                                          // Debug information
        '/fd', 'SHA256',                                   // File digest algorithm
        '/tr', 'http://timestamp.acs.microsoft.com',       // Timestamp server
        '/td', 'SHA256',                                   // Timestamp digest algorithm
        '/dlib', process.env.AZURE_CODE_SIGNING_DLIB!,     // Azure signing library
        '/dmdf', process.env.AZURE_METADATA_JSON!,         // Azure metadata file
      ].join(' '),
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
