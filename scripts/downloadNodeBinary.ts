/**
 * Download Node.js binary for the current platform.
 * 
 * This script downloads the official Node.js binary and extracts just the
 * node executable to artifacts/node-binary/. This is used during packaging
 * to bundle a standalone Node.js runtime that doesn't show dock icons on macOS.
 * 
 * Usage:
 *   npx tsx scripts/downloadNodeBinary.ts
 *   npx tsx scripts/downloadNodeBinary.ts --version 20.10.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import https from 'https';

// Default Node.js version to download (should match Electron's Node version)
// Electron 39 uses Node 20.x
const DEFAULT_NODE_VERSION = '20.18.1';

const getNodeVersion = (): string => {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf('--version');
  if (versionIndex !== -1 && args[versionIndex + 1]) {
    return args[versionIndex + 1];
  }
  return DEFAULT_NODE_VERSION;
};

const getPlatformInfo = (): { platform: string; arch: string; ext: string } => {
  const platform = process.platform;
  const arch = process.arch;

  let nodePlatform: string;
  let nodeArch: string;
  let ext: string;

  switch (platform) {
    case 'darwin':
      nodePlatform = 'darwin';
      ext = 'tar.gz';
      break;
    case 'win32':
      nodePlatform = 'win';
      ext = 'zip';
      break;
    case 'linux':
      nodePlatform = 'linux';
      ext = 'tar.gz';
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  switch (arch) {
    case 'x64':
      nodeArch = 'x64';
      break;
    case 'arm64':
      nodeArch = 'arm64';
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  return { platform: nodePlatform, arch: nodeArch, ext };
};

const downloadFile = (url: string, dest: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url}...`);
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(redirectUrl, dest).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\rDownloading... ${percent}%`);
        }
      });

      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log('\nDownload complete.');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
};

const extractNodeBinary = (archivePath: string, outputDir: string, nodeVersion: string, platformInfo: { platform: string; arch: string; ext: string }): void => {
  const nodeDirName = `node-v${nodeVersion}-${platformInfo.platform}-${platformInfo.arch}`;
  const tempDir = path.join(outputDir, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  
  if (platformInfo.ext === 'tar.gz') {
    console.log('Extracting tar.gz archive...');
    // Use system tar command (available on macOS, Linux, and modern Windows)
    execSync(`tar -xzf "${archivePath}" -C "${tempDir}"`, { stdio: 'inherit' });
    
    // Copy just the node binary
    const nodeBinarySrc = path.join(tempDir, nodeDirName, 'bin', 'node');
    const nodeBinaryDest = path.join(outputDir, 'node');
    
    if (!fs.existsSync(nodeBinarySrc)) {
      throw new Error(`Node binary not found at ${nodeBinarySrc}`);
    }
    
    fs.copyFileSync(nodeBinarySrc, nodeBinaryDest);
    fs.chmodSync(nodeBinaryDest, 0o755);
    
    console.log(`Node binary extracted to ${nodeBinaryDest}`);
  } else if (platformInfo.ext === 'zip') {
    console.log('Extracting zip archive...');
    // Use PowerShell on Windows to extract zip
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}'"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -q "${archivePath}" -d "${tempDir}"`, { stdio: 'inherit' });
    }
    
    // Copy just the node binary
    const nodeBinarySrc = path.join(tempDir, nodeDirName, 'node.exe');
    const nodeBinaryDest = path.join(outputDir, 'node.exe');
    
    if (!fs.existsSync(nodeBinarySrc)) {
      throw new Error(`Node binary not found at ${nodeBinarySrc}`);
    }
    
    fs.copyFileSync(nodeBinarySrc, nodeBinaryDest);
    
    console.log(`Node binary extracted to ${nodeBinaryDest}`);
  }
  
  // Clean up
  fs.rmSync(tempDir, { recursive: true });
  fs.unlinkSync(archivePath);
};

const main = async () => {
  const nodeVersion = getNodeVersion();
  const platformInfo = getPlatformInfo();
  
  console.log(`Downloading Node.js v${nodeVersion} for ${platformInfo.platform}-${platformInfo.arch}...`);
  
  // Create output directory
  const outputDir = path.join(__dirname, '..', 'artifacts', 'node-binary');
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Check if already downloaded
  const nodeExeName = platformInfo.platform === 'win' ? 'node.exe' : 'node';
  const existingBinary = path.join(outputDir, nodeExeName);
  if (fs.existsSync(existingBinary)) {
    console.log(`Node binary already exists at ${existingBinary}`);
    console.log('Delete it manually if you want to re-download.');
    return;
  }
  
  // Download URL
  const fileName = `node-v${nodeVersion}-${platformInfo.platform}-${platformInfo.arch}.${platformInfo.ext}`;
  const url = `https://nodejs.org/dist/v${nodeVersion}/${fileName}`;
  
  // Download
  const archivePath = path.join(outputDir, fileName);
  await downloadFile(url, archivePath);
  
  // Extract just the node binary
  extractNodeBinary(archivePath, outputDir, nodeVersion, platformInfo);
  
  console.log('Done!');
};

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
