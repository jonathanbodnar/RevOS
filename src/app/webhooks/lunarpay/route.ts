/**
 * Alias for the LunarPay webhook receiver.
 *
 * LunarPay's webhook registration examples point at `/webhooks/lunarpay`, so we
 * expose the same handler here in addition to `/api/webhooks/lunarpay`. The
 * implementation lives in the API route; this just re-exports it.
 */
export { POST } from "@/app/api/webhooks/lunarpay/route";
