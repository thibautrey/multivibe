import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionGrant } from "./authorization.js";

export interface ExecutionReceipt {
  version: 1;
  attemptId: string;
  reservationId: string;
  routeVersionId: string;
  providerId: string;
  bodySha256: string;
  state: "completed" | "uncertain" | "not_executed";
  usage: Record<string, unknown> | null;
  responseSha256: string | null;
  status: number | null;
  finishedAt: number;
}
/** A durable, exclusive attempt fence. Share one journal per executor identity;
 * an unresolved claim is never retried automatically, including after restart.
 * Files contain execution metadata and usage only, never prompts or credentials.
 */
export class ExecutionJournal {
  constructor(private readonly directory: string) {}
  private path(attemptId: string, suffix: string): string {
    return join(this.directory, createHash("sha256").update(attemptId).digest("hex") + suffix);
  }
  private async writeOnce(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    const dir = await open(this.directory, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async claim(grant: Readonly<ExecutionGrant>): Promise<void> {
    try {
      await this.writeOnce(this.path(grant.attemptId, ".claim"), {
        attemptId: grant.attemptId, reservationId: grant.reservationId,
        bodySha256: grant.bodySha256, routeVersionId: grant.routeVersionId,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("execution_already_claimed");
      throw error;
    }
  }
  async finish(receipt: ExecutionReceipt): Promise<void> {
    const claim = JSON.parse(await readFile(this.path(receipt.attemptId, ".claim"), "utf8"));
    if (claim.attemptId !== receipt.attemptId || claim.reservationId !== receipt.reservationId
      || claim.bodySha256 !== receipt.bodySha256 || claim.routeVersionId !== receipt.routeVersionId) throw Error("receipt_claim_mismatch");
    const destination = this.path(receipt.attemptId, ".receipt");
    const temporary = this.path(receipt.attemptId, `.receipt-${randomUUID()}.pending`);
    try {
      // Publish only a fully written and synced record. A concurrent reader must
      // observe either no receipt or a complete receipt, never partial JSON.
      await this.writeOnce(temporary, receipt);
      await link(temporary, destination);
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async receipt(attemptId: string): Promise<ExecutionReceipt | undefined> {
    try { return JSON.parse(await readFile(this.path(attemptId, ".receipt"), "utf8")) as ExecutionReceipt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
