#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { evaluateCodingEconomy } from "../src/coding-economy-benchmark.ts";

const USAGE = `Usage: benchmark-coding-economy.mjs [options]

Reads MultiVibe trace JSONL and reports cost per complete task for the
cost-optimized coding profile. Measured API cash and the modelled parent
baseline are reported separately; nothing here is an invoice or a measured
saving.

Options:
  --trace <path>          Trace JSONL file (default: $TRACE_FILE_PATH)
  --parent-model <id>     Strong model used as the counterfactual baseline
  --margin <percent>      Predicted saving required to count as economic (default: 20)
  --limit <count>         Evaluate at most this many tasks
  --json                  Print machine-readable JSON instead of a table
`;

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { margin: 20, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--trace") options.trace = next();
    else if (arg === "--parent-model") options.parentModel = next();
    else if (arg === "--margin") options.margin = Number(next());
    else if (arg === "--limit") options.limit = Number(next());
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") { process.stdout.write(USAGE); process.exit(0); }
    else fail(`Unexpected argument: ${arg}`);
  }
  if (!Number.isFinite(options.margin) || options.margin < 0) fail("--margin must be a non-negative number");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) fail("--limit must be a positive integer");
  return options;
}

async function readTraces(filePath) {
  const traces = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let skipped = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      traces.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  if (skipped) process.stderr.write(`Skipped ${skipped} unreadable trace line(s)\n`);
  return traces;
}

function money(value) {
  return typeof value === "number" ? `$${value.toFixed(6)}` : "unknown";
}

const options = parseArgs(process.argv.slice(2));
const tracePath = options.trace ?? process.env.TRACE_FILE_PATH;
if (!tracePath) fail("No trace file given: pass --trace <path> or set TRACE_FILE_PATH");
if (!fs.existsSync(tracePath)) fail(`Trace file not found: ${tracePath}`);

const evaluation = evaluateCodingEconomy(await readTraces(path.resolve(tracePath)), {
  parentModel: options.parentModel,
  marginPercent: options.margin,
  limit: options.limit,
});

if (options.json) {
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
} else {
  process.stdout.write(`Cost-optimized coding — ${evaluation.totals.tasks} task(s) from ${tracePath}\n`);
  if (!options.parentModel) {
    process.stdout.write("No --parent-model given: baseline and predicted saving stay unknown (never zero).\n");
  }
  process.stdout.write("\n");
  process.stdout.write(
    ["task", "turns", "cache", "measured", "baseline", "saving", "margin"].join("\t") + "\n",
  );
  for (const task of evaluation.tasks) {
    process.stdout.write([
      task.taskId,
      String(task.turns),
      task.cacheState,
      money(task.measuredApiCashUsd),
      money(task.baselineParentCostUsd),
      money(task.predictedSavingUsd),
      task.meetsMargin === undefined ? "unknown" : task.meetsMargin ? "yes" : "no",
    ].join("\t") + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(`Total measured API cash: ${money(evaluation.totals.measuredApiCashUsd)}\n`);
  process.stdout.write(`Modelled parent baseline: ${money(evaluation.totals.baselineParentCostUsd)}\n`);
  process.stdout.write(`Predicted saving: ${money(evaluation.totals.predictedSavingUsd)} (threshold ${evaluation.marginPercent}%)\n`);
  process.stdout.write(`Uneconomic tasks: ${evaluation.totals.uneconomicTasks}; tasks with unpriced turns: ${evaluation.totals.priceIncompleteTasks}\n`);
}
