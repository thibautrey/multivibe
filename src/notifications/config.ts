import {
  MULTIVIBE_CLOUD_API_BASE_URL,
  MULTIVIBE_SMTP_ENABLED,
  SMTP_FROM,
  SMTP_HOST,
  SMTP_PASSWORD,
  SMTP_PORT,
  SMTP_REPLY_TO,
  SMTP_SECURE,
  SMTP_USER,
} from "../config.js";

/**
 * Resolved SMTP settings.
 *
 * `enabled` is deliberately separate from completeness: enabling email with a
 * half-filled configuration must stay a quiet no-op, not crash billing hooks.
 */
export type SmtpConfig = {
  enabled: boolean;
  host?: string;
  port: number;
  /** true = implicit TLS (usually port 465); false = STARTTLS is required. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  replyTo?: string;
  /** Base dashboard URL for CTA links; trailing slashes are removed. */
  appUrl: string;
};

/** Read the process environment once, through the constants in `config.ts`. */
export function smtpConfigFromEnv(): SmtpConfig {
  return {
    enabled: MULTIVIBE_SMTP_ENABLED,
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER,
    password: SMTP_PASSWORD,
    from: SMTP_FROM,
    replyTo: SMTP_REPLY_TO,
    appUrl: MULTIVIBE_CLOUD_API_BASE_URL,
  };
}

/**
 * A host and sender are required. Authentication is optional for local relays,
 * but a username without a password (or the reverse) is treated as incomplete
 * so a missing secret cannot silently downgrade to unauthenticated delivery.
 */
export function hasCompleteSmtpConfig(config: SmtpConfig): boolean {
  if (!config.host?.trim()) return false;
  if (!config.from.trim()) return false;
  if (Boolean(config.user) !== Boolean(config.password)) return false;
  return true;
}
