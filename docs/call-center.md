# Call center

The call center works each clinic's leads from `/call-center`, one clinic at a
time. It is the Dial Desk prototype (a single HTML file with its data in the
browser) rebuilt inside RevOS, with a shared database and calls placed through
Telnyx. Importing leads, the clinic connect link and the CRM connectors are in
[`call-center-import.md`](./call-center-import.md).

Code: `src/lib/call-center/` (logic), `src/app/call-center/` (pages),
`src/app/api/call-center/` (routes), `src/app/api/webhooks/telnyx/route.ts`.

## Who can use it

| Role | Access |
| --- | --- |
| `SUPER_ADMIN` | Every active clinic, plus **Phone setup** (connect Telnyx, buy numbers). |
| `CALL_AGENT` | Only the clinics listed for them in `CallCenterAccess`. Created in Admin → Users with role "Call center" and a clinic list. Signs in straight to `/call-center`. No patients, billing or clinic settings. |
| Everyone else | No access. |

Guards: `src/lib/call-center/access.ts`. Pages use `requireCallCenterPage` /
`requireCallCenterClinicPage` (404 for a clinic the agent can't work); routes use
`clinicRoute()` (`route-helpers.ts`), which validates path params first and then
returns 401 / 403 / 404. `src/lib/call-center/routes-security.test.ts` pins this.

## Screens (per clinic)

- **Today** (`desk-client.tsx`): the Dial Desk layout. Left, today's list by
  section; right, the person to call now with the outcome buttons and keyboard
  shortcuts (1–7 results, S skip, N note, C copy number, / search); top, the
  day's tally and the browser phone. Opening a lead from search or from Leads
  pins it on the card (`?open=<leadId>`).
- **Leads**: every lead with status filters, search, and an add-lead form.
- **Report**: the daily flash text (copy into Slack instead of the paper form),
  who was booked, talk time, and the week so far.
- **Import**: see [`call-center-import.md`](./call-center-import.md).
- **Call rules**: the clinic's rules (below).

## The day's list (`queue.ts`)

A port of the Dial Desk's `buildPlan()`, recomputed from the database on every
request so several agents (and the auto dialer) share one list:

1. **Callbacks**: stage `nurture` whose call-back time is today or earlier.
2. **Confirmations**: booked leads 2 days, 1 day, or the morning of their
   appointment (each touch only once; none after the appointment).
3. **Rebooks**: stage `resched` due today.
4. **Follow-ups**: stage `cycle` due today and not already tried today, capped
   at `dailyTarget − worked − above − freshFloor`; the rest are "held" for the
   next work day.
5. **New leads**: on new-lead days, the remaining room (priority first, then
   oldest), plus any "Add 25 new leads" for the day (`CallDay`).

"Done" items come from today's `LeadActivity` rows (`kind` = the section).
"Skip for now" sends a lead to the end of the day. A lead another agent has
open is skipped for the current card (`Lead.claimedById/claimedUntil`, 3-minute
claim).

## What a result does (`outcomes.ts`)

A port of the Dial Desk's `logOutcome` / `finishNA`:

- **No answer** counts one try per day; after `spacingDays` work days it comes
  back; after `maxAttempts` it's lost ("Unable to contact").
- **Straight to voicemail** (double-dial on): the first one keeps the lead open
  ("dial once more right now"); the result of the second dial finishes it. Never
  leave a voicemail on these calls.
- **Booked** sets the appointment and resets confirmation calls. **Call back**
  sets the time. **Not interested** → lost. **Not qualified**, **Remove, do not
  call** → never called again.
- Confirmation calls: **Confirmed** stops them; **No answer** on the morning of
  puts the lead on the front-desk text list; **Cancelled** → rebook from the
  next work day; after `rebookAttempts` no-answers the front desk texts them.
- "Update without a call": showed, clinic says cancelled / no-show, set status,
  priority, appointment time, put back in rotation.

Notes are encrypted (`encryptField`). Every change writes `LeadActivity`.

## Call rules (`rules.ts`, `CallRules`)

Per clinic, edited on the Call rules tab by agents or super admins. Defaults are
the Dial Desk's: 200 dials a day, 4 tries 2 work days apart, Mon–Fri, new leads
Tue–Fri, 9 AM–7 PM clinic time, 3 rebook tries, confirmations at 48 h / 24 h /
morning-of, at most 3 calls per person in 24 hours, double-dial on, 25-second
ring. Guard rails the page can't loosen: never Sunday, calls only between
8 AM and 9 PM clinic time, at most 10 calls per person per 24 hours. A clinic
without a row uses the defaults with the time zone guessed from its state.

## Calling (`dialer.ts`, `telnyx.ts`)

Telnyx's documented outbound-dialer pattern:

1. **Go live**: the desk asks for a session (`DialerSession`), gets a 24-hour
   JWT for the agent's browser phone (one on-demand telephony credential per
   agent, `User.telnyxCredentialId`), and the Telnyx WebRTC SDK places one call
   carrying the `X-RevOS-Session` SIP header. The agents' credential connection
   has call parking on, so Telnyx parks that call and sends `call.initiated`;
   RevOS answers it. That leg is the agent's line for the whole session. A leg
   from a different credential than the session's agent is hung up.
2. **Each call**: `POST /calls` on the Call Control application from the
   clinic's Telnyx number (`ClinicPhoneNumber`), then the lead leg is bridged
   onto the agent's line with `park_after_unbridge=self` so the agent's line
   survives the lead hanging up.
   - Manual: bridged as soon as it starts ringing (ringback, then the person).
   - Auto: bridged on answer, or with **Skip voicemails** on, when answering
     machine detection (premium) says it's a person; machines are hung up and
     logged as voicemail.
3. **Auto-dial** is progressive: one call at a time per agent, so a person who
   answers is always connected to a live agent. A no-answer is redialed once
   right away when double-dial is on, then the next lead in list order.
   Confirmation calls and call-backs whose time hasn't come are left to the
   agent. It stops (and says why) at the end of the list, outside calling hours,
   or when the desk stops polling (75-second heartbeat).
4. **Inbound**: a call to a clinic's number rings the first free agent working
   that clinic. With nobody free, the caller hears a short message and the lead
   goes to the top of Callbacks (booked / do-not-call leads keep their status).

Every dial re-checks on the server: calling hours, do-not-call, the 24-hour cap,
written consent (auto only, when "Only auto-dial leads with written consent" is
on), and the lead claim. Webhook handlers move state with conditional updates,
so retried or out-of-order events are harmless; `sessionState()` frees a call
Telnyx never reported back on.

Without phone setup the desk still works the Dial Desk way: dial from your own
phone ("Call from this computer" opens `tel:`) and log the result.

## Phone setup (super admin, `/call-center/phone-setup`)

1. Set `TELNYX_API_KEY` and `TELNYX_PUBLIC_KEY` (see
   [`operations.md`](./operations.md)). Use different keys for Dev and production.
2. **Set up Telnyx** creates a US-only outbound voice profile, the Call Control
   application and the agents' credential connection, pointed at
   `${NEXT_PUBLIC_APP_URL}/api/webhooks/telnyx`, and stores their ids in
   `CallCenterSettings`. Running it again only re-points the webhooks.
3. Give each clinic a number: search by area code or state and **Buy** (starts a
   monthly charge), or **Attach** a number already in the account. Removing a
   number in RevOS does not release it from Telnyx.

## Webhook (`/api/webhooks/telnyx`)

Ed25519 signature over `${telnyx-timestamp}|${raw body}` with
`TELNYX_PUBLIC_KEY`, timestamp within 5 minutes. Fails closed (503) without the
key, 401 on a bad signature. Events are handled after the 200 (`after()`).
Handled: `call.initiated`, `call.answered`, `call.bridged`,
`call.machine.premium.detection.ended` / `call.machine.detection.ended`,
`call.speak.ended`, `call.hangup`.

## Data

`Lead`, `LeadActivity`, `LeadCall`, `DialerSession`, `CallRules`, `CallDay`,
`ClinicPhoneNumber`, `CallCenterAccess`, `CallCenterSettings` (see
[`data-model.md`](./data-model.md)). Lead phone numbers are 10 digits and
unique per clinic.

## Not built yet

- Texting (Premiere Wellness as the sender) waits on A2P 10DLC approval.
- Pushing bookings to the clinic's CRM and the team Google Calendar.
- Call recording (Florida needs everyone's consent; recordings would be PHI at Telnyx).
- Undo of the last result (the Dial Desk had it).

## Testing locally

Unit tests: `queue.test.ts`, `outcomes.test.ts`, `telnyx.test.ts`,
`routes-security.test.ts`. For the dialer end to end, run the built app against
a local Postgres with `TELNYX_API_BASE` pointed at a fake Telnyx server that
signs its webhooks with a throwaway Ed25519 key (set `TELNYX_PUBLIC_KEY` to its
public half). Never use a shared database.
