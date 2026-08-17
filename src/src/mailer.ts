// ============================================================
// Mailer — MVP-ONLY STOPGAP
// ============================================================
//
// DO NOT treat this as permanent architecture - see
// unmonitored-device-job.ts's header, which is this file's only
// caller. Sends whatever's sitting in persistence.ts's
// notification_queue table via SMTP (nodemailer). This is the
// "forward" half of store-and-forward: the queue itself is the
// durability (survives a restart, a network outage, an SMTP relay
// being briefly down); this file's job is just to keep retrying
// delivery until it succeeds, not to invent its own persistence.
//
// Credentials come from environment variables, not config.ts -
// unlike the illustrative UniFi placeholder already in config.ts,
// SMTP credentials are real secrets and don't belong committed to
// the repo, even as a "REPLACE_ME" placeholder.
// ============================================================

import nodemailer from "nodemailer";
import type { RackWatchStore, QueuedNotification } from "./persistence";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true for implicit TLS (typically port 465), false for STARTTLS (typically port 587)
  user: string;
  pass: string;
  from: string;
}

// Reads from the environment rather than throwing at import time -
// this file may be loaded in contexts (e.g. tests) that never call
// sendQueuedNotifications, so validation happens lazily, on first use.
export function smtpConfigFromEnv(): SmtpConfig | undefined {
  const host = process.env.RACKWATCH_SMTP_HOST;
  const user = process.env.RACKWATCH_SMTP_USER;
  const pass = process.env.RACKWATCH_SMTP_PASS;
  const from = process.env.RACKWATCH_SMTP_FROM;
  if (!host || !user || !pass || !from) return undefined; // not configured - caller decides what that means

  return {
    host,
    port: Number(process.env.RACKWATCH_SMTP_PORT ?? 587),
    secure: process.env.RACKWATCH_SMTP_SECURE === "true",
    user,
    pass,
    from,
  };
}

// ---- Send every currently-unsent notification. Never throws for an
// individual send failure - that's an expected, retryable outcome
// (mirrors every adapter in this codebase: a failed attempt is data,
// not an exception), tracked via attempts for visibility. Only a
// missing/invalid SMTP config itself is treated as an error worth
// surfacing to the caller, since that's a configuration problem, not
// a transient delivery one. ----

export interface SendQueuedNotificationsResult {
  sent: number;
  failed: number;
}

export async function sendQueuedNotifications(
  store: RackWatchStore,
  smtpConfig: SmtpConfig | undefined = smtpConfigFromEnv()
): Promise<SendQueuedNotificationsResult> {
  const pending = store.loadUnsentNotifications();
  if (pending.length === 0) return { sent: 0, failed: 0 };

  if (!smtpConfig) {
    console.warn(
      `[mailer] ${pending.length} notification(s) queued but SMTP is not configured ` +
        "(RACKWATCH_SMTP_HOST/USER/PASS/FROM) - nothing sent, will retry once configured"
    );
    return { sent: 0, failed: pending.length };
  }

  const transport = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });

  let sent = 0;
  let failed = 0;
  for (const notification of pending) {
    try {
      await sendOne(transport, smtpConfig.from, notification);
      store.markNotificationSent(notification.id);
      sent++;
    } catch (err) {
      // Adapter-trouble-not-device-trouble, same principle as every
      // other check in this codebase: an SMTP hiccup this cycle isn't
      // a reason to drop the notification, just to try again next time.
      store.incrementNotificationAttempt(notification.id);
      console.warn(
        `[mailer] failed to send notification ${notification.id} (attempt ${notification.attempts + 1}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      failed++;
    }
  }

  return { sent, failed };
}

function sendOne(
  transport: ReturnType<typeof nodemailer.createTransport>,
  from: string,
  notification: QueuedNotification
): Promise<unknown> {
  return transport.sendMail({
    from,
    to: notification.recipient,
    subject: notification.subject,
    text: notification.body,
  });
}
