import assert from "node:assert/strict";
import test from "node:test";
import { runtimeIdentityForAccount } from "../src/lib/runtimeCatalog.js";

test("DeepSeek AI-SDK accounts use the bundled DeepSeek identity", () => {
  assert.deepEqual(
    runtimeIdentityForAccount({ provider: "ai-sdk", sdkProvider: "deepseek" }),
    {
      id: "deepseek",
      label: "DeepSeek",
      iconUrl: "/assets/providers/deepseek.svg",
      homepageUrl: "https://www.deepseek.com",
    },
  );
});
