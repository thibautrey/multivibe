import { normalizeEmail, isValidEmail } from "../users.js";
import {
  hasCompleteSmtpConfig,
  smtpConfigFromEnv,
  type SmtpConfig,
} from "./config.js";
import { renderNotification } from "./templates.js";
import { createSmtpTransport } from "./transport.js";
import type {
  EmailMessage,
  EmailTransport,
  NotificationEvent,
  NotificationResult,
  NotificationUserLookup,
  SendNotificationInput,
} from "./types.js";

export type NotificationLogger = {
  warn(message: string): void;
};

export type NotificationServiceOptions = {
  /** Explicit settings, mostly for tests. Defaults to the process environment. */
  config?: SmtpConfig;
  /** Inject a fake transport; production lazily creates the nodemailer one. */
  transport?: EmailTransport;
  /** `undefined` logs a single sanitized warning, `null` disables logging. */
  logger?: NotificationLogger | null;
};

const CONSOLE_LOGGER: NotificationLogger = {
  warn: (message) => console.warn(message),
};

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

/** Defense in depth: an SMTP error must never echo the password or username. */
function redactSecrets(text: string, config: SmtpConfig): string {
  let redacted = text;
  for (const secret of [config.password, config.user]) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

/**
 * Transactional account emails.
 *
 * Delivery is opt-in and never lets a notification break the caller: disabled
 * or incomplete SMTP settings, a missing user or a missing email address all
 * return a `skipped` result. A transport error returns `failed`; nothing in
 * this class throws because of configuration or delivery.
 */
export class NotificationService {
  private readonly config: SmtpConfig;
  private readonly injectedTransport?: EmailTransport;
  private readonly logger: NotificationLogger | null;
  private transport?: EmailTransport;

  constructor(options: NotificationServiceOptions = {}) {
    this.config = options.config ?? smtpConfigFromEnv();
    this.injectedTransport = options.transport;
    this.logger = options.logger === undefined ? CONSOLE_LOGGER : options.logger;
  }

  /**
   * Resolve the recipient from the account store, then send the event.
   * Suspended members still receive account email; only a missing or invalid
   * address is skipped.
   */
  async notifyUserEvent(
    store: NotificationUserLookup,
    userId: string,
    event: NotificationEvent,
  ): Promise<NotificationResult> {
    const unavailable = this.unavailableReason();
    if (unavailable) {
      return { status: "skipped", type: event.type, reason: unavailable };
    }

    const user = await store.findUser(userId);
    if (!user) {
      return { status: "skipped", type: event.type, reason: "user_not_found" };
    }
    return this.deliver(user.email, event, user.name);
  }

  /**
   * Send to an explicit address when there is no user record (for example an
   * operator-triggered notice). The address is normalized and validated.
   */
  async sendNotification(
    input: SendNotificationInput,
    recipientName?: string,
  ): Promise<NotificationResult> {
    const event = {
      type: input.type,
      data: input.data,
    } as NotificationEvent;
    const unavailable = this.unavailableReason();
    if (unavailable) {
      return { status: "skipped", type: event.type, reason: unavailable };
    }
    return this.deliver(input.to, event, recipientName);
  }

  private unavailableReason(): "disabled" | "incomplete_config" | undefined {
    if (!this.config.enabled) return "disabled";
    if (!hasCompleteSmtpConfig(this.config)) return "incomplete_config";
    return undefined;
  }

  private transportFor(config: SmtpConfig): EmailTransport {
    if (this.injectedTransport) return this.injectedTransport;
    this.transport ??= createSmtpTransport(config);
    return this.transport;
  }

  private async deliver(
    recipient: string,
    event: NotificationEvent,
    recipientName?: string,
  ): Promise<NotificationResult> {
    const to = normalizeEmail(recipient);
    if (!to || !isValidEmail(to)) {
      return { status: "skipped", type: event.type, reason: "missing_email" };
    }

    try {
      const rendered = renderNotification(event, {
        recipientName,
        appUrl: this.config.appUrl,
      });
      const message: EmailMessage = {
        to,
        from: singleLine(this.config.from),
        replyTo: this.config.replyTo
          ? singleLine(this.config.replyTo)
          : undefined,
        ...rendered,
      };
      const info = await this.transportFor(this.config).send(message);
      return {
        status: "sent",
        type: event.type,
        to,
        messageId: info?.messageId,
      };
    } catch (error) {
      const message = redactSecrets(errorText(error), this.config);
      this.logger?.warn(`notifications: ${event.type} email failed: ${message}`);
      return { status: "failed", type: event.type, error: message };
    }
  }
}

export function createNotificationService(
  options: NotificationServiceOptions = {},
): NotificationService {
  return new NotificationService(options);
}

let defaultService: NotificationService | undefined;

function serviceFor(options?: NotificationServiceOptions): NotificationService {
  if (options) return new NotificationService(options);
  defaultService ??= new NotificationService();
  return defaultService;
}

/** Convenience wrapper for a store-backed user event. */
export function notifyUserEvent(
  store: NotificationUserLookup,
  userId: string,
  event: NotificationEvent,
  options?: NotificationServiceOptions,
): Promise<NotificationResult> {
  return serviceFor(options).notifyUserEvent(store, userId, event);
}

/** Convenience wrapper for an explicit recipient. */
export function sendNotification(
  input: SendNotificationInput,
  options?: NotificationServiceOptions,
): Promise<NotificationResult> {
  return serviceFor(options).sendNotification(input);
}

export type {
  NotificationEvent,
  NotificationEventData,
  NotificationEventType,
  NotificationPayloads,
} from "./types.js";
