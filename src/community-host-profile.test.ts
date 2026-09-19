import assert from "node:assert/strict";
import test from "node:test";
import {
  communityHostFromCapability,
  detectCommunityHost,
  sanitizeHardwareName,
  type HostDetectionCommand,
} from "./community-host-profile.js";

const GIB = 1024 ** 3;

/** Command runner fixture keyed by the first two arguments. */
function runner(outputs: Record<string, string>): HostDetectionCommand {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    const output = outputs[key];
    if (output === undefined) throw new Error(`unexpected command: ${key}`);
    if (output === "<fail>") throw new Error(`${file} failed`);
    return output;
  };
}

test("the supervised provider capability is reused as the bounded host descriptor", () => {
  const nvidia = communityHostFromCapability({
    profile: "linux-nvidia",
    os: "linux",
    architecture: "x64",
    accelerator: "cuda",
    hardware_model: "linux-nvidia",
    accelerator_memory_bytes: 8 * GIB,
    gpus: [{ name: "NVIDIA GeForce RTX 4090", memory_mib: 24_564 }],
  }, 64 * GIB);
  assert.equal(nvidia?.acceleratorKind, "cuda");
  assert.equal(nvidia?.acceleratorName, "NVIDIA GeForce RTX 4090");
  assert.equal(nvidia?.acceleratorMemoryBytes, 24_564 * 1024 * 1024);
  assert.equal(nvidia?.architecture, "amd64");
  assert.equal(nvidia?.hostMemoryBytes, 64 * GIB);
  assert.equal(nvidia?.machineModel, "");

  const apple = communityHostFromCapability({
    profile: "apple-silicon",
    os: "darwin",
    architecture: "arm64",
    accelerator: "metal",
    hardware_model: "Apple M4 Max",
    accelerator_memory_bytes: 128 * GIB,
  }, 128 * GIB);
  assert.equal(apple?.acceleratorKind, "metal");
  assert.equal(apple?.acceleratorName, "Apple M4 Max");
  assert.equal(apple?.os, "darwin");
  assert.equal(apple?.architecture, "arm64");

  assert.equal(communityHostFromCapability({ os: "plan9", architecture: "arm64" }, GIB), undefined);
  assert.equal(communityHostFromCapability({ os: "linux", architecture: "mips" }, GIB), undefined);
  assert.equal(communityHostFromCapability({ os: "linux", architecture: "amd64" }, GIB), undefined);
});

test("bounded local detection covers macOS, NVIDIA, ROCm and CPU-only machines", async () => {
  const darwin = await detectCommunityHost({
    platform: "darwin",
    architecture: "arm64",
    totalMemoryBytes: 512 * GIB,
    run: runner({
      "sysctl -n machdep.cpu.brand_string": "Apple M3 Ultra\n",
      "sysctl -n hw.model": "Mac14,14\n",
      "sysctl -n hw.memsize": String(512 * GIB),
    }),
  });
  assert.equal(darwin?.acceleratorKind, "metal");
  assert.equal(darwin?.acceleratorName, "Apple M3 Ultra");
  assert.equal(darwin?.acceleratorMemoryBytes, 512 * GIB);
  assert.equal(darwin?.machineModel, "Mac14,14");

  const nvidia = await detectCommunityHost({
    platform: "linux",
    architecture: "x64",
    totalMemoryBytes: 64 * GIB,
    run: runner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": "NVIDIA GeForce RTX 4090, 24564\n",
    }),
  });
  assert.equal(nvidia?.acceleratorKind, "cuda");
  assert.equal(nvidia?.acceleratorName, "NVIDIA GeForce RTX 4090");
  assert.equal(nvidia?.acceleratorMemoryBytes, 24_564 * 1024 * 1024);

  const rocm = await detectCommunityHost({
    platform: "linux",
    architecture: "amd64",
    totalMemoryBytes: 32 * GIB,
    run: runner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": "<fail>",
      "rocm-smi --showproductname --showmeminfo vram --csv": "Card series: Radeon RX 7900 XTX\nVRAM Total Memory (B): 25753026560\n",
    }),
  });
  assert.equal(rocm?.acceleratorKind, "rocm");
  assert.equal(rocm?.acceleratorName, "Radeon RX 7900 XTX");
  assert.equal(rocm?.acceleratorMemoryBytes, 25_753_026_560);

  const cpu = await detectCommunityHost({
    platform: "linux",
    architecture: "arm64",
    totalMemoryBytes: 16 * GIB,
    run: runner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": "<fail>",
      "rocm-smi --showproductname --showmeminfo vram --csv": "<fail>",
    }),
  });
  assert.equal(cpu?.acceleratorKind, "cpu");
  assert.equal(cpu?.acceleratorMemoryBytes, 0);
  assert.equal(cpu?.hostMemoryBytes, 16 * GIB);
  assert.equal(cpu?.architecture, "arm64");

  const windows = await detectCommunityHost({
    platform: "win32",
    architecture: "x64",
    totalMemoryBytes: 32 * GIB,
    run: runner({
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": "NVIDIA GeForce RTX 3080, 10240\n",
    }),
  });
  assert.equal(windows?.os, "windows");
  assert.equal(windows?.acceleratorKind, "cuda");

  assert.equal(await detectCommunityHost({ platform: "sunos", architecture: "amd64", run: runner({}) }), undefined);
  assert.equal(await detectCommunityHost({ platform: "linux", architecture: "mips", run: runner({}) }), undefined);
});

test("host names are bounded to printable, single-line text", () => {
  assert.equal(sanitizeHardwareName("  NVIDIA\to GeForce \u0000RTX 4090  "), "NVIDIA o GeForce RTX 4090");
  assert.equal(sanitizeHardwareName("x".repeat(120)), "x".repeat(80));
  assert.equal(sanitizeHardwareName("Apple M4 Max", 48), "Apple M4 Max");
  assert.equal(sanitizeHardwareName(""), "");
});
