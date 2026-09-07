#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "assets", "brand");
const destinationRoot = path.join(repositoryRoot, "web", "public", "assets", "brand");

const publicBrandAssets = [
  ["favicon/android-chrome-192x192.png", "android-chrome-192x192.png"],
  ["favicon/android-chrome-512x512.png", "android-chrome-512x512.png"],
  ["favicon/apple-touch-icon.png", "apple-touch-icon.png"],
  ["favicon/favicon-1024.png", "favicon-1024.png"],
  ["favicon/favicon-128x128.png", "favicon-128x128.png"],
  ["favicon/favicon-16x16.png", "favicon-16x16.png"],
  ["favicon/favicon-180x180.png", "favicon-180x180.png"],
  ["favicon/favicon-192x192.png", "favicon-192x192.png"],
  ["favicon/favicon-256x256.png", "favicon-256x256.png"],
  ["favicon/favicon-32x32.png", "favicon-32x32.png"],
  ["favicon/favicon-48x48.png", "favicon-48x48.png"],
  ["favicon/favicon-512x512.png", "favicon-512x512.png"],
  ["favicon/favicon-64x64.png", "favicon-64x64.png"],
  ["favicon/favicon.ico", "favicon.ico"],
  ["favicon/favicon.svg", "favicon.svg"],
  ["favicon/site.webmanifest", "site.webmanifest"],
  ["vector/multivibe-app-icon.svg", "multivibe-app-icon.svg"],
  ["vector/multivibe-logo-name-dark-outlined.svg", "multivibe-logo-name-dark-outlined.svg"],
  ["vector/multivibe-logo-name-light-outlined.svg", "multivibe-logo-name-light-outlined.svg"],
];

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true, mode: 0o755 });
for (const [source, destination] of publicBrandAssets) {
  await cp(path.join(sourceRoot, source), path.join(destinationRoot, destination));
}
