import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { emptyData } from "./types.js";
import type {
  ConnectAccount,
  Enrollment,
  IdempotencyRecord,
  Instance,
  MarketplaceData,
  OutboxEvent,
  Payment,
  RefundRecord,
  StripeEventRecord,
} from "./types.js";

const MAX_OUTBOX_EVENTS = 10_000;
const MAX_IDEMPOTENCY_RECORDS = 5_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Broker persistence. The MVP keeps one JSON document so the service runs with
 * no external dependency; every read and write goes through this class, so a
 * Postgres adapter can replace it without touching the routes.
 *
 * Mutations are in-memory and flushed atomically (write + rename) through a
 * serialized queue. The broker is a single process by design: instances pull
 * from it, so a load-balanced deployment needs the shared SQL adapter first.
 */
export class MarketplaceStore {
  private data: MarketplaceData = emptyData();
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly filePath?: string) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MarketplaceData>;
      const base = emptyData();
      this.data = {
        ...base,
        ...parsed,
        schemaVersion: 1,
        instances: parsed.instances ?? [],
        enrollments: parsed.enrollments ?? [],
        accounts: parsed.accounts ?? [],
        payments: parsed.payments ?? [],
        refunds: parsed.refunds ?? [],
        outbox: parsed.outbox ?? [],
        stripeEvents: parsed.stripeEvents ?? [],
        idempotency: parsed.idempotency ?? [],
        counters: parsed.counters ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async flush(): Promise<void> {
    if (!this.filePath) return;
    const filePath = this.filePath;
    const snapshot = JSON.stringify(this.data, null, 2);
    const run = async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot);
      await fs.rename(temporary, filePath);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    await next;
  }

  private async commit(): Promise<void> {
    await this.flush();
  }

  // --- Instances -----------------------------------------------------------

  async createInstance(instance: Instance): Promise<Instance> {
    this.data.instances.push(clone(instance));
    await this.commit();
    return clone(instance);
  }

  findInstance(id: string): Instance | undefined {
    const found = this.data.instances.find((candidate) => candidate.id === id);
    return found ? clone(found) : undefined;
  }

  findInstanceBySecretHash(hash: string): Instance | undefined {
    const found = this.data.instances.find((candidate) => candidate.secretHash === hash);
    return found ? clone(found) : undefined;
  }

  async updateInstance(id: string, patch: Partial<Instance>): Promise<Instance | undefined> {
    const index = this.data.instances.findIndex((candidate) => candidate.id === id);
    if (index === -1) return undefined;
    this.data.instances[index] = { ...this.data.instances[index], ...patch, id };
    await this.commit();
    return clone(this.data.instances[index]);
  }

  listInstances(): Instance[] {
    return this.data.instances.map(clone);
  }

  async suspendInstance(id: string): Promise<Instance | undefined> {
    return this.updateInstance(id, { status: "suspended", suspendedAt: Date.now() });
  }

  async resumeInstance(id: string): Promise<Instance | undefined> {
    return this.updateInstance(id, { status: "active", suspendedAt: undefined });
  }

  // --- Enrollments ---------------------------------------------------------

  async createEnrollment(enrollment: Enrollment): Promise<void> {
    this.data.enrollments.push(clone(enrollment));
    await this.commit();
  }

  findEnrollmentByCode(code: string): Enrollment | undefined {
    const found = this.data.enrollments.find((candidate) => candidate.code === code);
    return found ? clone(found) : undefined;
  }

  findEnrollmentByDeviceHash(hash: string): Enrollment | undefined {
    const found = this.data.enrollments.find((candidate) => candidate.deviceCodeHash === hash);
    return found ? clone(found) : undefined;
  }

  async updateEnrollment(id: string, patch: Partial<Enrollment>): Promise<void> {
    const index = this.data.enrollments.findIndex((candidate) => candidate.id === id);
    if (index === -1) return;
    this.data.enrollments[index] = { ...this.data.enrollments[index], ...patch, id };
    await this.commit();
  }

  // --- Connect accounts ----------------------------------------------------

  findAccountByInstance(instanceId: string): ConnectAccount | undefined {
    const found = this.data.accounts.find((candidate) => candidate.instanceId === instanceId);
    return found ? clone(found) : undefined;
  }

  findAccountByStripeId(stripeAccountId: string): ConnectAccount | undefined {
    const found = this.data.accounts.find(
      (candidate) => candidate.stripeAccountId === stripeAccountId,
    );
    return found ? clone(found) : undefined;
  }

  async upsertAccount(account: ConnectAccount): Promise<ConnectAccount> {
    const index = this.data.accounts.findIndex(
      (candidate) => candidate.instanceId === account.instanceId,
    );
    if (index === -1) this.data.accounts.push(clone(account));
    else this.data.accounts[index] = clone(account);
    await this.commit();
    return clone(account);
  }

  // --- Payments ------------------------------------------------------------

  async createPayment(payment: Payment): Promise<Payment> {
    this.data.payments.push(clone(payment));
    await this.commit();
    return clone(payment);
  }

  /** Alias kept for readability at call sites that create a checkout intent. */
  createCheckoutIntent(payment: Payment): Promise<Payment> {
    return this.createPayment(payment);
  }

  findPayment(id: string): Payment | undefined {
    const found = this.data.payments.find((candidate) => candidate.id === id);
    return found ? clone(found) : undefined;
  }

  findPaymentBySession(sessionId: string): Payment | undefined {
    const found = this.data.payments.find((candidate) => candidate.sessionId === sessionId);
    return found ? clone(found) : undefined;
  }

  findPaymentByIntent(paymentIntentId: string): Payment | undefined {
    const found = this.data.payments.find(
      (candidate) => candidate.paymentIntentId === paymentIntentId,
    );
    return found ? clone(found) : undefined;
  }

  listPayments(instanceId: string, since = 0, limit = 100): Payment[] {
    return this.data.payments
      .filter((payment) => payment.instanceId === instanceId && payment.createdAt >= since)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.min(500, Math.max(1, limit)))
      .map(clone);
  }

  /** Operator view: every payment, newest first. */
  listAllPayments(limit = 500): Payment[] {
    return this.data.payments
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, Math.min(2000, Math.max(1, limit)))
      .map(clone);
  }

  listRefunds(instanceId?: string): RefundRecord[] {
    return this.data.refunds
      .filter((refund) => !instanceId || refund.instanceId === instanceId)
      .map(clone);
  }

  async updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | undefined> {
    const index = this.data.payments.findIndex((candidate) => candidate.id === id);
    if (index === -1) return undefined;
    this.data.payments[index] = { ...this.data.payments[index], ...patch, id };
    await this.commit();
    return clone(this.data.payments[index]);
  }

  // --- Refunds -------------------------------------------------------------

  findRefund(stripeRefundId: string): RefundRecord | undefined {
    const found = this.data.refunds.find(
      (candidate) => candidate.stripeRefundId === stripeRefundId,
    );
    return found ? clone(found) : undefined;
  }

  async addRefund(refund: RefundRecord): Promise<void> {
    if (this.findRefund(refund.stripeRefundId)) return;
    this.data.refunds.push(clone(refund));
    await this.commit();
  }

  // --- Stripe events -------------------------------------------------------

  hasStripeEvent(id: string): boolean {
    return this.data.stripeEvents.some((event) => event.id === id);
  }

  /** Returns false when the event was already stored (at-least-once delivery). */
  async recordStripeEvent(event: StripeEventRecord): Promise<boolean> {
    if (this.hasStripeEvent(event.id)) return false;
    this.data.stripeEvents.push(clone(event));
    if (this.data.stripeEvents.length > 20_000) {
      this.data.stripeEvents = this.data.stripeEvents.slice(-20_000);
    }
    await this.commit();
    return true;
  }

  // --- Event outbox --------------------------------------------------------

  async appendEvent(
    instanceId: string,
    type: string,
    payload: Record<string, unknown>,
    stripeEventId?: string,
    now = Date.now(),
  ): Promise<OutboxEvent> {
    const seq = (this.data.counters[instanceId] ?? 0) + 1;
    this.data.counters[instanceId] = seq;
    const event: OutboxEvent = {
      seq,
      instanceId,
      type,
      payload,
      createdAt: now,
      ...(stripeEventId ? { stripeEventId } : {}),
    };
    this.data.outbox.push(event);
    const cutoff = now - EVENT_RETENTION_MS;
    this.data.outbox = this.data.outbox
      .filter((candidate) => candidate.createdAt >= cutoff)
      .slice(-MAX_OUTBOX_EVENTS);
    await this.commit();
    return clone(event);
  }

  listEvents(instanceId: string, after: number, limit: number): OutboxEvent[] {
    return this.data.outbox
      .filter((event) => event.instanceId === instanceId && event.seq > after)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit)
      .map(clone);
  }

  lastEventSeq(instanceId: string): number {
    return this.data.counters[instanceId] ?? 0;
  }

  // --- Idempotency ---------------------------------------------------------

  findIdempotency(instanceId: string, key: string): IdempotencyRecord | undefined {
    const found = this.data.idempotency.find(
      (candidate) => candidate.instanceId === instanceId && candidate.key === key,
    );
    return found ? clone(found) : undefined;
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<void> {
    this.data.idempotency = this.data.idempotency.filter(
      (candidate) =>
        !(candidate.instanceId === record.instanceId && candidate.key === record.key),
    );
    this.data.idempotency.push(clone(record));
    if (this.data.idempotency.length > MAX_IDEMPOTENCY_RECORDS) {
      this.data.idempotency = this.data.idempotency.slice(-MAX_IDEMPOTENCY_RECORDS);
    }
    await this.commit();
  }

  // --- Tests and tooling ---------------------------------------------------

  snapshot(): MarketplaceData {
    return clone(this.data);
  }
}

/** Helper shared by routes to build a payment id. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}
