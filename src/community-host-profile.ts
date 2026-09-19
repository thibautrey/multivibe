import { execFile as execFileCallback, type ExecFileOptions } from "node:child_process";
import { arch as hostArch, platform as hostPlatform, totalmem } from "node:os";

/**
 * Bounded host descriptor for the opt-in community report. Only an accelerator
 * kind, a sanitized accelerator name, two memory sizes, the OS, the CPU
 * architecture and (locally) the machine model are ever derived here. Cloud
 * reduces this to a public hardware profile before storing anything, and the
 * machine model never leaves the request.
 */

export type CommunityAcceleratorKind = "cuda" | "metal" | "rocm" | "vulkan" | "cpu";
export type CommunityHostOs = "linux" | "darwin" | "windows";
export type CommunityHostArchitecture = "amd64" | "arm64";

export type CommunityHostDescriptor = Readonly<{
  acceleratorKind: CommunityAcceleratorKind;
  acceleratorName: string;
  acceleratorMemoryBytes: number;
  hostMemoryBytes: number;
  os: CommunityHostOs;
  architecture: CommunityHostArchitecture;
  machineModel: string;
}>;

export type ProviderHostCapabilityLike = Readonly<{
  profile?: string;
  os?: string;
  architecture?: string;
  accelerator?: string;
  hardware_model?: string;
  accelerator_memory_bytes?: number;
  gpus?: readonly Readonly<{ name?: string; memory_mib?: number }>[];
}>;

export type HostDetectionCommand = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const MAX_NAME = 80;
const MAX_MACHINE_MODEL = 48;
const DETECTION_TIMEOUT_MS = 2_000;

export function sanitizeHardwareName(value: string, maximum = MAX_NAME): string {
  return String(value ?? "")
    // Keep printable characters only; the value is validated as text by Cloud.
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function hostOs(value: string): CommunityHostOs | undefined {
  if (value === "linux" || value === "darwin" || value === "windows") return value;
  if (value === "darwin" || value.startsWith("darwin")) return "darwin";
  if (value.startsWith("win")) return "windows";
  if (value.startsWith("linux")) return "linux";
  return undefined;
}

function hostArchitecture(value: string): CommunityHostArchitecture | undefined {
  if (value === "amd64" || value === "x64" || value === "x86_64") return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return undefined;
}

function acceleratorKind(value: string | undefined): CommunityAcceleratorKind {
  switch ((value ?? "").toLowerCase()) {
    case "cuda": return "cuda";
    case "metal": case "mps": return "metal";
    case "rocm": case "hip": return "rocm";
    case "vulkan": return "vulkan";
    default: return "cpu";
  }
}

/** Maps the supervised Provider Agent capability, which already detected the machine. */
export function communityHostFromCapability(
  capability: ProviderHostCapabilityLike,
  fallbackHostMemoryBytes: number,
): CommunityHostDescriptor | undefined {
  const os = hostOs(capability.os ?? "");
  const architecture = hostArchitecture(capability.architecture ?? "");
  if (!os || !architecture) return undefined;
  const gpu = capability.gpus?.find((entry) => typeof entry.name === "string" && entry.name.trim().length > 0);
  const acceleratorName = sanitizeHardwareName(gpu?.name ?? capability.hardware_model ?? "");
  if (!acceleratorName) return undefined;
  const acceleratorMemoryBytes = Math.max(
    0,
    Math.round(gpu?.memory_mib !== undefined && Number.isFinite(gpu.memory_mib)
      ? gpu.memory_mib * 1024 * 1024
      : capability.accelerator_memory_bytes ?? 0),
  );
  return Object.freeze({
    acceleratorKind: acceleratorKind(capability.accelerator),
    acceleratorName,
    acceleratorMemoryBytes,
    hostMemoryBytes: Math.max(0, Math.round(fallbackHostMemoryBytes)),
    os,
    architecture,
    machineModel: sanitizeHardwareName("", MAX_MACHINE_MODEL),
  });
}

export type HostDetectionOptions = Readonly<{
  /** Injectable command runner so detection stays testable and bounded. */
  run?: HostDetectionCommand;
  platform?: string;
  architecture?: string;
  totalMemoryBytes?: number;
  timeoutMs?: number;
}>;

function defaultRunner(timeoutMs: number): HostDetectionCommand {
  return (file, args, timeout) => new Promise<string>((resolve, reject) => {
    const argv = [...args];
    const options: ExecFileOptions = { timeout, maxBuffer: 64 * 1024, windowsHide: true };
    execFileCallback(file, argv, options, (error, stdout: string | Buffer) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

async function attempt(run: HostDetectionCommand, file: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const output = await run(file, args, timeoutMs);
    return output.trim();
  } catch {
    return undefined;
  }
}

function nvidiaGpu(output: string | undefined): { name: string; memoryBytes: number } | undefined {
  if (!output) return undefined;
  const first = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return undefined;
  const [name, memoryText] = first.split(",").map((part) => part.trim());
  if (!name || !memoryText) return undefined;
  const memoryMiB = Number(memoryText);
  if (!Number.isFinite(memoryMiB) || memoryMiB <= 0) return undefined;
  return { name, memoryBytes: Math.round(memoryMiB * 1024 * 1024) };
}

function rocmGpu(output: string | undefined): { name: string; memoryBytes: number } | undefined {
  if (!output) return undefined;
  const name = /(?:Card series|Card model|GPU\[0\]\s*:\s*)(?:\s*:\s*)?([^,\n]+)/iu.exec(output)?.[1]?.trim();
  const bytes = /(?:VRAM Total Memory \(B\)|vram total memory \(b\))\s*[:\s]\s*(\d+)/iu.exec(output)?.[1];
  if (!name) return undefined;
  const memoryBytes = bytes && Number.isFinite(Number(bytes)) ? Number(bytes) : 0;
  return { name, memoryBytes };
}

/**
 * Bounded local detection used when the supervised Provider Agent capability is
 * unavailable. Every command is optional; CPU and host memory always resolve.
 */
export async function detectCommunityHost(options: HostDetectionOptions = {}): Promise<CommunityHostDescriptor | undefined> {
  const timeoutMs = options.timeoutMs ?? DETECTION_TIMEOUT_MS;
  const run = options.run ?? defaultRunner(timeoutMs);
  const platform = options.platform ?? hostPlatform();
  const architecture = hostArchitecture(options.architecture ?? hostArch());
  if (!architecture) return undefined;
  const os = hostOs(platform);
  if (!os) return undefined;
  const totalMemoryBytes = Math.max(0, Math.round(options.totalMemoryBytes ?? totalmem()));

  if (os === "darwin") {
    const [chip, machineModel, memory] = await Promise.all([
      attempt(run, "sysctl", ["-n", "machdep.cpu.brand_string"], timeoutMs),
      attempt(run, "sysctl", ["-n", "hw.model"], timeoutMs),
      attempt(run, "sysctl", ["-n", "hw.memsize"], timeoutMs),
    ]);
    const name = sanitizeHardwareName(chip ?? "Apple Silicon");
    const memoryBytes = memory && Number.isFinite(Number(memory)) ? Number(memory) : totalMemoryBytes;
    return Object.freeze({
      acceleratorKind: "metal",
      acceleratorName: name,
      // Unified memory: the usable accelerator budget is the host memory.
      acceleratorMemoryBytes: Math.max(0, Math.round(memoryBytes)),
      hostMemoryBytes: totalMemoryBytes,
      os,
      architecture,
      machineModel: sanitizeHardwareName(machineModel ?? "", MAX_MACHINE_MODEL),
    });
  }

  const nvidia = nvidiaGpu(await attempt(run, "nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], timeoutMs));
  if (nvidia) {
    return Object.freeze({
      acceleratorKind: "cuda",
      acceleratorName: sanitizeHardwareName(nvidia.name),
      acceleratorMemoryBytes: nvidia.memoryBytes,
      hostMemoryBytes: totalMemoryBytes,
      os,
      architecture,
      machineModel: "",
    });
  }
  const amd = rocmGpu(await attempt(run, "rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--csv"], timeoutMs));
  if (amd) {
    return Object.freeze({
      acceleratorKind: "rocm",
      acceleratorName: sanitizeHardwareName(amd.name),
      acceleratorMemoryBytes: amd.memoryBytes,
      hostMemoryBytes: totalMemoryBytes,
      os,
      architecture,
      machineModel: "",
    });
  }
  return Object.freeze({
    acceleratorKind: "cpu",
    acceleratorName: sanitizeHardwareName(`${os} ${architecture} CPU`),
    acceleratorMemoryBytes: 0,
    hostMemoryBytes: totalMemoryBytes,
    os,
    architecture,
    machineModel: "",
  });
}
