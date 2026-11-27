import fs from "node:fs/promises";
import path from "node:path";

export type PendingEnrollment = {
  code: string;
  deviceCode: string;
  expiresAt: number;
  verificationUrl: string;
};

export type PaymentsCredentials = {
  version: 1;
  brokerUrl: string;
  instanceId?: string;
  secret?: string;
  pending?: PendingEnrollment;
};

/**
 * Instance credentials live outside `accounts.json`, in a 0600 file, because
 * the dashboard exports the store to admins and the secret must never leak
 * through a data dump or a log.
 */
export async function readCredentials(
  filePath: string,
): Promise<PaymentsCredentials | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PaymentsCredentials>;
    if (
      parsed.version !== 1 ||
      typeof parsed.brokerUrl !== "string" ||
      (!parsed.pending &&
        (typeof parsed.secret !== "string" || typeof parsed.instanceId !== "string"))
    ) {
      throw new Error(`Invalid marketplace credentials in ${filePath}`);
    }
    return parsed as PaymentsCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCredentials(
  filePath: string,
  credentials: PaymentsCredentials,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function deleteCredentials(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
