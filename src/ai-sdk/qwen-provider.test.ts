import assert from "node:assert/strict";
import test from "node:test";
import { QWEN_CODING_PLAN_CHINA_BASE_URL, QWEN_MODELS, QWEN_PROVIDER } from "./qwen-provider.js";

test("declares Alibaba Coding Plan's dedicated compatible endpoints", () => {
  assert.deepEqual(QWEN_PROVIDER, {
    id: "qwen-coding",
    name: "Qwen Coding Plan (Alibaba)",
    adapter: "compatible",
    baseURL: "https://coding-intl.dashscope.aliyuncs.com/v1",
  });
  assert.equal(QWEN_CODING_PLAN_CHINA_BASE_URL, "https://coding.dashscope.aliyuncs.com/v1");
});

test("lists only the exact model IDs published for Coding Plan", () => {
  assert.deepEqual(QWEN_MODELS.map(({ id }) => id), [
    "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus", "qwen3-max-2026-01-23",
    "qwen3-coder-next", "qwen3-coder-plus", "glm-5", "glm-4.7", "kimi-k2.5", "MiniMax-M2.5",
  ]);
});
