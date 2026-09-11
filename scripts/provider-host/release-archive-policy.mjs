export function validateReleaseArchives(names) {
  const targets = new Set();
  const versions = new Set();
  if (names.length < 1 || names.length > 4) throw new Error('release requires one to four verified native archives');
  for (const name of names) {
    const match = /^multivibe-host_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_(darwin_arm64\.dmg|darwin_amd64\.dmg|linux_amd64\.tar\.gz|windows_amd64\.zip)$/.exec(name);
    if (!match || targets.has(match[2])) throw new Error(`unsupported or duplicate release archive: ${name}`);
    versions.add(match[1]); targets.add(match[2]);
  }
  if (versions.size !== 1) throw new Error('release archives must share one version');
}

export function validateMacVerification(report, name, digest, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || report.sourceCommit !== commit ||
      report.verified !== true || report.releaseReady !== true || report.sourceTreeDirty !== false ||
      report.runtimeChecked !== false || report.archiveSha256 !== digest || report.platform !== 'darwin' ||
      !['arm64', 'amd64'].includes(report.architecture) ||
      name !== `multivibe-host_${report.version}_darwin_${report.architecture}.dmg`) {
    throw new Error(`attested macOS verification report does not match the release archive: ${name}`);
  }
  return report;
}
