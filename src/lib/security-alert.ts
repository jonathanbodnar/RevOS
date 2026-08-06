/**
 * Security alerting — fire-and-forget notification of suspicious events to a
 * configured endpoint (SECURITY_ALERT_WEBHOOK_URL; e.g. a Slack/Zapier hook or
 * an on-call webhook). Payloads carry NO PHI — only event type, actor id, and
 * coarse context. Skipped when the env var is unset.
 */

export type SecurityEvent =
  | "auth.repeated_failures"
  | "admin.wipe_attempt"
  | "impersonation.start"
  | "mfa.disabled"
  // A stored MFA secret can't be decrypted — that account cannot log in until
  // an operator resets it. Always a server misconfiguration, never user error.
  | "auth.mfa_secret_unreadable";

export async function securityAlert(
  event: SecurityEvent,
  detail: Record<string, string | number | boolean | null>,
): Promise<void> {
  const url = process.env.SECURITY_ALERT_WEBHOOK_URL;
  if (!url) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        severity: "security",
        timestamp: new Date().toISOString(),
        app: "RevOS",
        ...detail,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    // Never let alerting failures affect the request.
  } finally {
    clearTimeout(timeout);
  }
}
