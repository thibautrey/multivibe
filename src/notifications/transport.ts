import nodemailer from "nodemailer";
import type { SmtpConfig } from "./config.js";
import type { EmailMessage, EmailTransport } from "./types.js";

/**
 * Real SMTP transport. Kept behind `EmailTransport` so unit tests never touch
 * the network and so a future provider (API-based email) can be substituted.
 *
 * STARTTLS is mandatory when `secure` is false: a server that cannot upgrade
 * the connection fails instead of receiving credentials in clear text.
 */
export function createSmtpTransport(config: SmtpConfig): EmailTransport {
  if (!config.host) throw new Error("SMTP host is required");

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    // Never print protocol traffic: SMTP commands contain credentials and the
    // DATA phase contains the message body.
    logger: false,
    debug: false,
  });

  return {
    async send(message: EmailMessage) {
      const info = await transporter.sendMail({
        from: message.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return {
        messageId: typeof info.messageId === "string" ? info.messageId : undefined,
      };
    },
  };
}
