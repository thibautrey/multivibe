#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const builds = [
  { job: 'build-linux', artifact: 'provider-host-linux', label: 'Linux amd64', required: true },
  { job: 'build-macos-arm64', artifact: 'provider-host-macos-arm64', label: 'macOS Apple Silicon' },
  { job: 'build-macos-amd64', artifact: 'provider-host-macos-amd64', label: 'macOS Intel' },
  { job: 'build-windows', artifact: 'provider-host-windows', label: 'Windows amd64' },
];

export function quotaBlocked(job, annotations) {
  // Runner admission errors occur before build steps execute. Never classify a compiler/test failure as quota.
  if (!job || !['failure', 'success'].includes(job.conclusion) || (job.steps ?? []).some(step => !['skipped', null].includes(step.conclusion))) return false;
  return annotations.some(annotation => annotation.annotation_level === 'failure' &&
    /(?:spending limit|(?:included|actions|runner|billable|free).*minutes.*(?:exhausted|exceeded|used|limit)|(?:exhausted|exceeded).*minutes|billing.*(?:quota|budget)|budget.*(?:exhausted|exceeded))/i.test(annotation.message ?? ''));
}

export function selectArtifacts(jobs, artifacts, annotations = {}, hostedDisabled = false) {
  const selected = [], omitted = [];
  for (const build of builds) {
    if (!build.required && hostedDisabled) { omitted.push(`${build.label}: GitHub-hosted builds disabled`); continue; }
    const job = jobs.find(job => job.name === build.job);
    const matches = artifacts.filter(artifact => artifact.name === build.artifact && !artifact.expired);
    if (matches.length > 1) throw new Error(`Ambiguous release artifacts: ${build.artifact}`);
    const artifact = matches[0];
    const failedStep = job?.steps?.some(step => ['failure', 'cancelled', 'timed_out'].includes(step.conclusion));
    if (job?.conclusion === 'success' && !failedStep && artifact) { selected.push(artifact); continue; }
    if (!build.required && quotaBlocked(job, annotations[job?.id] ?? [])) {
      if (artifact) throw new Error(`Unexpected artifact from quota-blocked job: ${build.job}`);
      omitted.push(`${build.label}: GitHub Actions runner quota / spending limit`);
      continue;
    }
    throw new Error(`Release blocked: ${build.job} did not complete successfully with its verified artifact (${job?.conclusion ?? 'missing job'}).`);
  }
  return { selected, omitted };
}

async function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GH_TOKEN: token } = process.env;
  if (repo !== 'thibautrey/multivibe' || !/^\d+$/.test(run ?? '') || !token) throw new Error('Release workflow identity unavailable');
  async function get(path) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Release evidence API returned HTTP ${response.status}`);
    return response.json();
  }
  async function pages(path, key) {
    const result = [];
    for (let page = 1; page <= 20; page++) {
      const body = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const values = key ? body[key] : body;
      if (!Array.isArray(values)) throw new Error('Invalid release evidence');
      result.push(...values);
      if (values.length < 100) return result;
    }
    throw new Error('Release evidence pagination limit reached');
  }
  const [jobs, artifacts] = await Promise.all([pages(`actions/runs/${run}/jobs?filter=latest`, 'jobs'), pages(`actions/runs/${run}/artifacts`, 'artifacts')]);
  const annotations = {};
  for (const job of jobs.filter(job => builds.some(build => build.job === job.name) && (job.conclusion === 'failure' || (job.conclusion === 'success' && !artifacts.some(artifact => artifact.name === builds.find(build => build.job === job.name)?.artifact && !artifact.expired))))) {
    const match = /^https:\/\/api\.github\.com\/repos\/thibautrey\/multivibe\/check-runs\/(\d+)$/.exec(job.check_run_url ?? '');
    if (match) annotations[job.id] = await pages(`check-runs/${match[1]}/annotations`);
  }
  const result = selectArtifacts(jobs, artifacts, annotations, process.env.HOSTED_DISABLED === 'true');
  const report = `## Platform availability\n\nBuilt: ${result.selected.map(a => builds.find(b => b.artifact === a.name).label).join(', ')}.\n\n${result.omitted.length ? `Not produced for this version:\n${result.omitted.map(reason => `- ${reason}`).join('\n')}\n` : 'All native platforms were built.\n'}`;
  const compatibility = result.omitted.length ? '\nOlder Hosts whose updater requires every platform target need a manual installation of this release. The updated updater supports partial releases.\n' : '';
  await writeFile('release-platforms.md', report + compatibility);
  await appendFile(process.env.GITHUB_OUTPUT, `artifact_ids=${result.selected.map(a => a.id).join(',')}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
