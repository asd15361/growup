#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
const packageJsonPath = path.join(projectRoot, 'package.json');
const sourceApkPath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

function readVersion() {
  const pkgRaw = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const version = String(pkg.version || '').trim();
  if (!version) {
    throw new Error('package.json version is missing');
  }
  return version;
}

function resolveJavaHome() {
  const current = process.env.JAVA_HOME || '';
  if (current && fs.existsSync(current)) {
    return current;
  }
  const candidates = [
    'C:\\Program Files\\Amazon Corretto\\jdk17.0.18_9',
    'C:\\Program Files\\Android\\Android Studio\\jbr',
  ];
  return candidates.find((item) => fs.existsSync(item)) || '';
}

function runGradleBuild(env) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'gradlew.bat', 'assembleRelease'], {
      cwd: androidDir,
      stdio: 'inherit',
      env,
    })
    : spawnSync('./gradlew', ['assembleRelease'], {
      cwd: androidDir,
      stdio: 'inherit',
      env,
    });
  if (result.status !== 0) {
    throw new Error(`assembleRelease failed with exit code ${result.status}`);
  }
}

function copyVersionedApk(version) {
  if (!fs.existsSync(sourceApkPath)) {
    throw new Error(`apk not found: ${sourceApkPath}`);
  }

  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, '_');
  const versionedName = `app-release-v${safeVersion}.apk`;
  const rootVersionedPath = path.join(projectRoot, versionedName);
  const rootLegacyPath = path.join(projectRoot, 'app-release.apk');

  fs.copyFileSync(sourceApkPath, rootVersionedPath);
  fs.copyFileSync(sourceApkPath, rootLegacyPath);

  const stat = fs.statSync(rootVersionedPath);
  return {
    versionedName,
    rootVersionedPath,
    rootLegacyPath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function main() {
  const version = readVersion();
  const env = { ...process.env };
  const javaHome = resolveJavaHome();
  if (javaHome) {
    env.JAVA_HOME = javaHome;
  }

  console.log(`[build:apk] version=${version}`);
  console.log(`[build:apk] JAVA_HOME=${env.JAVA_HOME || '(not set)'}`);

  runGradleBuild(env);

  const output = copyVersionedApk(version);
  console.log(`[build:apk] done: ${output.versionedName}`);
  console.log(`[build:apk] path=${output.rootVersionedPath}`);
  console.log(`[build:apk] legacy=${output.rootLegacyPath}`);
  console.log(`[build:apk] size=${output.size}`);
  console.log(`[build:apk] modified=${output.modifiedAt}`);
}

main();
