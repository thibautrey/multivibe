import type { AccountStore } from "../store.js";

/**
 * Payloads for every account email MultiVibe can send.
 *
 * The map is the extension point: add a key here, then add its renderer in
 * `templates.ts`. The switch on `event.type` is exhaustive, so the compiler
 * rejects a new event type until it has a template.
 */
export type NotificationPayloads = {
  /** Prepaid wallet fell at or below the configured low-balance threshold. */
  balance_low: {
    balanceUsd: number;
    thresholdUsd?: number;
    /** Absolute http(s) link override; defaults to `<appUrl>/billing`. */
    ctaUrl?: string;
  };
  /** A card top-up was credited to the prepaid wallet. */
  topup_succeeded: {
    amountUsd: number;
    /** Wallet balance after the top-up, when known. */
    balanceUsd?: number;
    /** Absolute http(s) link override; defaults to `<appUrl>/billing`. */
    ctaUrl?: string;
  };
  /** The member reached a configured spend limit. */
  spend_limit_reached: {
    limitUsd: number;
    spentUsd?: number;
    /** Human label such as "November 2026"; no dates are computed here. */
    periodLabel?: string;
    /** Absolute http(s) link override; defaults to `<appUrl>/billing`. */
    ctaUrl?: string;
  };
};

export type NotificationEventType = keyof NotificationPayloads;

export type NotificationEventData<K extends NotificationEventType> =
  NotificationPayloads[K];

/** Discriminated event accepted by the notification service. */
export type NotificationEvent = {
  [K in NotificationEventType]: { type: K; data: NotificationPayloads[K] };
}[NotificationEventType];

/** Input for the recipient-only API, `sendNotification({ to, type, data })`. */
export type SendNotificationInput = {
  to: string;
} & NotificationEvent;

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

export type EmailMessage = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

export type EmailTransportResult = { messageId?: string } | void;

/** Injectable transport boundary; production uses nodemailer over SMTP. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailTransportResult>;
}

export type NotificationSkipReason =
  | "disabled"
  | "incomplete_config"
  | "user_not_found"
  | "missing_email";

export type NotificationResult =
  | {
      status: "sent";
      type: NotificationEventType;
      to: string;
      messageId?: string;
    }
  | {
      status: "skipped";
      type: NotificationEventType;
      reason: NotificationSkipReason;
    }
  | {
      status: "failed";
      type: NotificationEventType;
      /** Sanitized error text; never contains SMTP credentials. */
      error: string;
    };

/** The subset of the account store the notifier needs. */
export type NotificationUserLookup = Pick<AccountStore, "findUser">;
