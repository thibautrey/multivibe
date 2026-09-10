import { GITHUB_REPOSITORY_URL } from "./github-promotion";

const LAST_RUNNING_VERSION_KEY = "multivibeLastRunningVersion";
const PENDING_RELEASE_VERSION_KEY = "multivibePendingReleaseVersion";

export type ReleaseAnnouncementStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type GitHubReleaseNotes = {
  version: string;
  title: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
  bannerUrl: string | null;
  bannerAlt: string;
};

type ParsedVersion = {
  core: number[];
  prerelease: Array<number | string>;
};

function normalizedVersion(value: string) {
  return value.trim().replace(/^v/iu, "");
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = normalizedVersion(value);
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(normalized);
  if (!match) return null;
  return {
    core: match[1].split(".").map(Number),
    prerelease: match[2]
      ? match[2].split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part.toLowerCase()))
      : [],
  };
}

export function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const coreLength = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function readReleaseAnnouncement(storage: ReleaseAnnouncementStorage, runningVersion: string) {
  const current = normalizedVersion(runningVersion);
  if (!parseVersion(current)) return null;

  const previous = storage.getItem(LAST_RUNNING_VERSION_KEY);
  const existingPending = storage.getItem(PENDING_RELEASE_VERSION_KEY);
  let pending = existingPending && parseVersion(existingPending) ? normalizedVersion(existingPending) : null;

  if (previous && compareVersions(current, previous) === 1) {
    pending = current;
    storage.setItem(PENDING_RELEASE_VERSION_KEY, current);
  }
  storage.setItem(LAST_RUNNING_VERSION_KEY, current);

  if (pending && compareVersions(current, pending) === 0) return current;
  if (pending) storage.removeItem(PENDING_RELEASE_VERSION_KEY);
  return null;
}

export function dismissReleaseAnnouncement(storage: ReleaseAnnouncementStorage, version: string) {
  const pending = storage.getItem(PENDING_RELEASE_VERSION_KEY);
  if (pending && compareVersions(pending, version) === 0) {
    storage.removeItem(PENDING_RELEASE_VERSION_KEY);
  }
}

function safeBannerUrl(value: string) {
  try {
    const url = new URL(value.replace(/^<|>$/gu, ""));
    const githubAttachment = url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/");
    const githubImageHost = url.hostname === "raw.githubusercontent.com" || url.hostname.endsWith(".githubusercontent.com");
    return url.protocol === "https:" && !url.username && !url.password && (githubAttachment || githubImageHost)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function extractReleaseBanner(markdown: string) {
  const imagePattern = /!\[([^\]\r\n]*)\]\(\s*(<?https:\/\/[^)\s>]+>?)\s*(?:["'][^"'\r\n]*["'])?\s*\)/giu;
  for (const match of markdown.matchAll(imagePattern)) {
    const bannerUrl = safeBannerUrl(match[2]);
    if (!bannerUrl || match.index === undefined) continue;
    const body = `${markdown.slice(0, match.index)}${markdown.slice(match.index + match[0].length)}`
      .replace(/^\s+|\s+$/gu, "");
    return { bannerUrl, bannerAlt: match[1].trim(), body };
  }
  return { bannerUrl: null, bannerAlt: "", body: markdown.trim() };
}

export async function fetchGitHubReleaseNotes(
  version: string,
  request: typeof fetch = fetch,
): Promise<GitHubReleaseNotes> {
  const normalized = normalizedVersion(version);
  const tag = `v${normalized}`;
  const response = await request(`https://api.github.com/repos/thibautrey/multivibe/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub release notes are unavailable (HTTP ${response.status}).`);
  const release = await response.json() as Record<string, unknown>;
  const body = typeof release.body === "string" ? release.body : "";
  const banner = extractReleaseBanner(body);
  return {
    version: normalized,
    title: typeof release.name === "string" && release.name.trim() ? release.name.trim() : `MultiVibe ${tag}`,
    body: banner.body,
    htmlUrl: typeof release.html_url === "string" && release.html_url.startsWith(`${GITHUB_REPOSITORY_URL}/releases/`)
      ? release.html_url
      : `${GITHUB_REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    bannerUrl: banner.bannerUrl,
    bannerAlt: banner.bannerAlt,
  };
}

export function releaseUrl(version: string) {
  return `${GITHUB_REPOSITORY_URL}/releases/tag/v${encodeURIComponent(normalizedVersion(version))}`;
}
