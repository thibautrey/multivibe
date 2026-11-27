export {
  NotificationService,
  createNotificationService,
  notifyUserEvent,
  sendNotification,
  type NotificationLogger,
  type NotificationServiceOptions,
} from "./service.js";
export {
  escapeHtml,
  formatUsd,
  renderNotification,
  type RenderNotificationOptions,
} from "./templates.js";
export {
  hasCompleteSmtpConfig,
  smtpConfigFromEnv,
  type SmtpConfig,
} from "./config.js";
export type {
  EmailMessage,
  EmailTransport,
  EmailTransportResult,
  NotificationEvent,
  NotificationEventData,
  NotificationEventType,
  NotificationPayloads,
  NotificationResult,
  NotificationSkipReason,
  NotificationUserLookup,
  RenderedEmail,
  SendNotificationInput,
} from "./types.js";
