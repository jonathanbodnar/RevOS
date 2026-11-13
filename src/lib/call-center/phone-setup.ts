/**
 * One-time Telnyx account setup, agent browser phones, and clinic numbers.
 *
 * "Set up Telnyx" (super admin, Call center → Phone setup) creates, once:
 *   - an outbound voice profile limited to US destinations;
 *   - a Call Control application: the clinic numbers and every lead call use
 *     it, and its events come to /api/webhooks/telnyx;
 *   - a credential connection with call parking on: each agent's browser phone
 *     registers through it (one on-demand telephony credential per agent).
 * Re-running it only points the webhooks at the current app URL.
 */
import crypto from "crypto";
import { prisma } from "../prisma";
import { telnyx, toE164, TelnyxError } from "./telnyx";

export function webhookUrlFor(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/webhooks/telnyx`;
}

function randomAlnum(n: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(n);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export async function setupTelnyx(appUrl: string) {
  if (!/^https:\/\//.test(appUrl)) {
    throw new TelnyxError("Telnyx needs an https app URL for its webhooks. Set NEXT_PUBLIC_APP_URL.", 400);
  }
  const webhookUrl = webhookUrlFor(appUrl);
  const cur = await prisma.callCenterSettings.findUnique({ where: { id: "default" } });

  let ovp = cur?.telnyxOutboundVoiceProfileId ?? null;
  if (!ovp) ovp = (await telnyx.createOutboundVoiceProfile("RevOS call center (US)")).id;

  let app = cur?.telnyxCallControlAppId ?? null;
  if (app) await telnyx.updateCallControlApp(app, { webhookUrl });
  else app = (await telnyx.createCallControlApp({ name: "RevOS call center", webhookUrl, outboundVoiceProfileId: ovp })).id;

  let cred = cur?.telnyxCredentialConnectionId ?? null;
  if (cred) await telnyx.updateCredentialConnection(cred, { webhookUrl });
  else {
    cred = (
      await telnyx.createCredentialConnection({
        name: "RevOS agent phones",
        userName: `revos${randomAlnum(12)}`,
        password: crypto.randomBytes(24).toString("base64url"),
        webhookUrl,
        outboundVoiceProfileId: ovp,
      })
    ).id;
  }

  return prisma.callCenterSettings.upsert({
    where: { id: "default" },
    create: { id: "default", telnyxOutboundVoiceProfileId: ovp, telnyxCallControlAppId: app, telnyxCredentialConnectionId: cred, webhookUrl },
    update: { telnyxOutboundVoiceProfileId: ovp, telnyxCallControlAppId: app, telnyxCredentialConnectionId: cred, webhookUrl },
  });
}

/** A 24-hour login token for this agent's browser phone (creates their credential the first time). */
export async function agentPhoneToken(userId: string): Promise<{ token: string; sipUsername: string }> {
  const settings = await prisma.callCenterSettings.findUnique({ where: { id: "default" } });
  if (!settings?.telnyxCredentialConnectionId) throw new TelnyxError("Phone setup isn't finished yet.", 409);
  let user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, telnyxCredentialId: true, telnyxSipUsername: true } });
  if (!user) throw new TelnyxError("User not found", 404);
  if (!user.telnyxCredentialId) {
    const c = await telnyx.createTelephonyCredential({
      connectionId: settings.telnyxCredentialConnectionId,
      name: `revos-agent-${user.id}`,
      tag: "revos-agent",
    });
    user = await prisma.user.update({
      where: { id: user.id },
      data: { telnyxCredentialId: c.id, telnyxSipUsername: c.sip_username },
      select: { id: true, telnyxCredentialId: true, telnyxSipUsername: true },
    });
  }
  const token = await telnyx.credentialToken(user.telnyxCredentialId!);
  return { token: token.trim(), sipUsername: user.telnyxSipUsername ?? "" };
}

export async function searchClinicNumbers(input: { areaCode?: string; state?: string; city?: string }) {
  const rows = await telnyx.searchNumbers({ ...input, limit: 12 });
  return (rows ?? []).map((r) => ({
    phoneNumber: r.phone_number,
    region: (r.region_information ?? []).map((x) => x.region_name).filter(Boolean).join(", "),
    monthly: r.cost_information?.monthly_cost ?? null,
    upfront: r.cost_information?.upfront_cost ?? null,
  }));
}

/** Buy a number for a clinic (spends money: super admin only, one explicit click). */
export async function buyClinicNumber(clinicId: string, phoneNumber: string) {
  const settings = await prisma.callCenterSettings.findUnique({ where: { id: "default" } });
  if (!settings?.telnyxCallControlAppId) throw new TelnyxError("Finish phone setup first.", 409);
  const e164 = toE164(phoneNumber);
  if (!/^\+1\d{10}$/.test(e164)) throw new TelnyxError("That isn't a US number.", 400);
  const order = await telnyx.orderNumber({ phoneNumber: e164, connectionId: settings.telnyxCallControlAppId, customerReference: `revos-clinic-${clinicId}` });
  const has = await prisma.clinicPhoneNumber.count({ where: { clinicId } });
  return prisma.clinicPhoneNumber.create({
    data: {
      clinicId,
      e164,
      telnyxNumberId: order.phone_numbers?.find((n) => n.phone_number === e164)?.id ?? null,
      isDefault: has === 0,
      label: "Calls and texts",
    },
  });
}

/** Attach a number that's already in the Telnyx account (bought in the portal). */
export async function attachExistingNumber(clinicId: string, phoneNumber: string) {
  const settings = await prisma.callCenterSettings.findUnique({ where: { id: "default" } });
  if (!settings?.telnyxCallControlAppId) throw new TelnyxError("Finish phone setup first.", 409);
  const e164 = toE164(phoneNumber);
  const n = await telnyx.findNumber(e164);
  if (!n) throw new TelnyxError("That number isn't in the Telnyx account.", 404);
  if (n.connection_id !== settings.telnyxCallControlAppId) await telnyx.assignNumber(n.id, settings.telnyxCallControlAppId);
  const has = await prisma.clinicPhoneNumber.count({ where: { clinicId } });
  return prisma.clinicPhoneNumber.create({
    data: { clinicId, e164, telnyxNumberId: n.id, isDefault: has === 0, label: "Calls and texts" },
  });
}
