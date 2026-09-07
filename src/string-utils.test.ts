import assert from "node:assert/strict";
import test from "node:test";
import { trimTrailingSlashes } from "./string-utils.js";

test("URL suffix trimming preserves internal paths and empty values", () => {
  for (const [input, expected] of [
    ["", ""], ["/", ""], ["///", ""],
    ["https://api.example/v1///", "https://api.example/v1"],
    ["https://api.example/v1", "https://api.example/v1"],
    ["/first//second/", "/first//second"],
  ]) assert.equal(trimTrailingSlashes(input), expected);
});
