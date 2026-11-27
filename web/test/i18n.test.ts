import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectLocale,
  interpolate,
  normalizeLocale,
  translate,
} from "../../packages/ui/src/i18n/core.js";
import shared from "../../packages/ui/src/i18n/fr/shared.js";
import app from "../../packages/ui/src/i18n/fr/app.js";
import overview from "../../packages/ui/src/i18n/fr/overview.js";
import models from "../../packages/ui/src/i18n/fr/models.js";
import accounts from "../../packages/ui/src/i18n/fr/accounts.js";
import providers from "../../packages/ui/src/i18n/fr/providers.js";
import sessions from "../../packages/ui/src/i18n/fr/sessions.js";
import invoices from "../../packages/ui/src/i18n/fr/invoices.js";
import routing from "../../packages/ui/src/i18n/fr/routing.js";
import activity from "../../packages/ui/src/i18n/fr/activity.js";
import api from "../../packages/ui/src/i18n/fr/api.js";
import docs from "../../packages/ui/src/i18n/fr/docs.js";
import plugins from "../../packages/ui/src/i18n/fr/plugins.js";
import updates from "../../packages/ui/src/i18n/fr/updates.js";
import host from "../../packages/ui/src/i18n/fr/host.js";
import users from "../../packages/ui/src/i18n/fr/users.js";
import audio from "../../packages/ui/src/i18n/fr/audio.js";

const CATALOGS: Record<string, Record<string, string>> = {
  shared, app, overview, models, accounts, providers, sessions, invoices,
  routing, activity, api, docs, plugins, updates, host, users, audio,
};

const UI_ROOT = new URL("../../packages/ui/src/", import.meta.url);

function sourceFiles(directory: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !path.pathname.includes("/i18n/")) files.push(path);
  }
  return files;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test("automatic language detection follows URL, storage, then browser preferences", () => {
  assert.equal(detectLocale({ search: "?lang=fr", stored: "en", languages: ["en-US"] }), "fr");
  assert.equal(detectLocale({ search: "?lang=en", stored: "fr", languages: ["fr-FR"] }), "en");
  assert.equal(detectLocale({ search: "", stored: "fr", languages: ["en-US"] }), "fr");
  assert.equal(detectLocale({ search: "", stored: null, languages: ["en-US", "fr-FR"] }), "en");
  assert.equal(detectLocale({ search: "", stored: null, languages: ["fr-CA", "en-US"] }), "fr");
  assert.equal(detectLocale({ search: "?lang=de", stored: null, languages: ["de-DE"] }), "en");
  assert.equal(detectLocale({}), "en");
  assert.equal(normalizeLocale("FR_ca"), "fr");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("de-DE"), undefined);
});

test("translations keep English by default and interpolate variables", () => {
  assert.equal(translate("en", "Available models"), "Available models");
  assert.equal(translate("fr", "Available models"), "Modèles disponibles");
  assert.equal(translate("fr", "Unknown key stays readable"), "Unknown key stays readable");
  assert.equal(interpolate("Page {page} of {pages}", { page: 2, pages: 5 }), "Page 2 of 5");
  assert.equal(translate("fr", "Page {page} of {pages}", { page: 2, pages: 5 }), "Page 2 sur 5");
  assert.equal(translate("fr", "Switch language to {language}", { language: "Français" }), "Changer la langue pour Français");
});

test("French catalogs are complete, non-empty, and placeholder-safe", () => {
  const seen = new Map<string, { value: string; file: string }>();
  for (const [file, catalog] of Object.entries(CATALOGS)) {
    for (const [source, value] of Object.entries(catalog)) {
      assert.ok(value.trim().length > 0, `${file}: empty translation for ${JSON.stringify(source)}`);
      assert.deepEqual(
        placeholders(value),
        placeholders(source),
        `${file}: placeholders differ for ${JSON.stringify(source)}`,
      );
      const previous = seen.get(source);
      if (previous) {
        assert.equal(
          previous.value,
          value,
          `Conflicting translations for ${JSON.stringify(source)} in ${previous.file} and ${file}`,
        );
      } else {
        seen.set(source, { value, file });
      }
    }
  }
  assert.ok(seen.size > 100, "the French catalog should cover the dashboard");
});

test("every literal passed to t() has a French translation", () => {
  const seen: Record<string, string> = {};
  for (const [file, catalog] of Object.entries(CATALOGS)) {
    for (const [source, value] of Object.entries(catalog)) seen[source] = value;
  }
  const missing: string[] = [];
  // Covers double-quoted, single-quoted and template-literal calls, including
  // multi-line keys. The catalog stores the same runtime string, so escapes are
  // decoded before the lookup.
  const call = /\b(?:t|tr)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  const decode = (raw: string) =>
    raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_all, escape: string) => {
      if (escape.startsWith("u") || escape.startsWith("x")) {
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      }
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escape] ?? escape;
    });
  for (const file of sourceFiles(UI_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(call)) {
      const key = decode(match[1] ?? match[2] ?? match[3] ?? "");
      if (!(key in seen)) missing.push(`${file.pathname.split("/packages/ui/src/")[1]}: ${JSON.stringify(key)}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
});
