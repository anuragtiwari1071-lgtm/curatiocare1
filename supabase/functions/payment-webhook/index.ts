import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function processEvent(eventId: string, eventType: string, event: any) {
  const paymentEntity = event?.payload?.payment?.entity;
  const orderEntity = event?.payload?.order?.entity;
  const paymentId = paymentEntity?.id || null;
  const orderId = paymentEntity?.order_id || orderEntity?.id || null;
  if (!orderId) throw new Error("Webhook does not contain a gateway order id");

  const { data: payment, error: lookupError } = await db
    .from("payments")
    .select("id, booking_id, amount, status, gateway_order_id, receipt_number")
    .eq("gateway_order_id", orderId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!payment) throw new Error("Unknown gateway order");

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const gatewayAmount = Number(paymentEntity?.amount ?? orderEntity?.amount_paid ?? 0) / 100;
    if (gatewayAmount && Math.abs(gatewayAmount - Number(payment.amount)) > 0.005) {
      throw new Error("Gateway amount does not match booking payment amount");
    }

    const update = {
      status: "received",
      gateway_payment_id: paymentId,
      gateway_event_id: eventId,
      transaction_reference: paymentId || payment.gateway_order_id,
      received_at: new Date().toISOString(),
      settlement_status: "pending",
      gateway_metadata: {
        event_type: eventType,
        gateway_order_status: orderEntity?.status || null,
        gateway_payment_status: paymentEntity?.status || null,
      },
    };

    const { error } = await db.from("payments").update(update).eq("id", payment.id);
    if (error) throw error;
  } else if (eventType === "payment.failed") {
    const { error } = await db.from("payments").update({
      status: "failed",
      gateway_payment_id: paymentId,
      gateway_event_id: eventId,
      failure_reason: paymentEntity?.error_description || paymentEntity?.error_code || "Payment failed",
      gateway_metadata: { event_type: eventType },
    }).eq("id", payment.id);
    if (error) throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SERVICE_ROLE_KEY || !WEBHOOK_SECRET) return new Response("Not configured", { status: 503 });

  // Signature MUST be calculated over the raw request body.
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature") || "";
  const eventId = req.headers.get("x-razorpay-event-id") || "";
  if (!signature || !eventId) return new Response("Missing webhook authentication", { status: 400 });

  const expected = await hmacSha256(WEBHOOK_SECRET, rawBody);
  if (!timingSafeEqual(expected, signature)) return new Response("Invalid signature", { status: 400 });

  let event: any;
  try { event = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const createdAt = Number(event?.created_at || 0);
  if (!createdAt || Math.abs(Math.floor(Date.now() / 1000) - createdAt) > 300) {
    return new Response("Stale webhook", { status: 400 });
  }

  const eventType = String(event?.event || "unknown");

  // Atomically claim the event. Duplicate deliveries become harmless.
  const { data: claimed, error: claimError } = await db
    .from("payment_webhook_events")
    .insert({ event_id: eventId, event_type: eventType, payload: event, status: "processing" })
    .select("event_id")
    .maybeSingle();

  if (claimError) {
    if (claimError.code === "23505") return new Response("ok", { status: 200 });
    console.error("Webhook event claim failed", claimError);
    return new Response("Temporary failure", { status: 500 });
  }

  const work = (async () => {
    try {
      await processEvent(eventId, eventType, event);
      await db.from("payment_webhook_events").update({
        status: "processed", processed_at: new Date().toISOString(), error_message: null,
      }).eq("event_id", eventId);
    } catch (error) {
      console.error("Payment webhook processing failed", error);
      await db.from("payment_webhook_events").update({
        status: "failed", error_message: String(error),
      }).eq("event_id", eventId);
    }
  })();

  // Acknowledge quickly after authentication and durable event claim.
  // Supabase Edge Runtime keeps the promise alive via waitUntil when available.
  const runtime = globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } };
  runtime.EdgeRuntime?.waitUntil(work);
  return new Response("ok", { status: 200 });
});
