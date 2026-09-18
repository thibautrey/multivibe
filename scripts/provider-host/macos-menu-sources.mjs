import { readdirSync, readFileSync } from "node:fs";

const macOSSourceDirectory = new URL("../../packaging/macos/", import.meta.url);

// The native macOS menu bar is split across several Swift files that compile as one module.
export function readMacOSMenuSourceSync() {
  return readdirSync(macOSSourceDirectory)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => readFileSync(new URL(name, macOSSourceDirectory), "utf8"))
    .join("\n");
}
