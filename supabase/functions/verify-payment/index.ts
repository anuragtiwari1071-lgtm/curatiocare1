import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function hex(bytes: ArrayBuffer) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function mobile(value: unknown) { return String(value ?? "").replace(/\D/g, "").slice(-10); }

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "Only POST requests are allowed." }, { status: 405 });
  if (!SERVICE_ROLE_KEY || !RAZORPAY_KEY_SECRET) return Response.json({ error: "Payment verification is not configured." }, { status: 503 });
  let body: any; try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }

  const paymentRecordId = String(body?.payment_record_id || "").trim();
  const paymentId = String(body?.razorpay_payment_id || "").trim();
  const callbackOrderId = String(body?.razorpay_order_id || "").trim();
  const signature = String(body?.razorpay_signature || "").trim();
  const patientMobile = mobile(body?.mobile);
  if (!paymentRecordId || !paymentId || !callbackOrderId || !signature || !/^\d{10}$/.test(patientMobile)) {
    return Response.json({ error: "Incomplete payment verification data." }, { status: 400 });
  }

  const { data: payment, error } = await db
    .from("payments")
    .select("id, booking_id, amount, status, gateway_order_id")
    .eq("id", paymentRecordId).maybeSingle();
  if (error) return Response.json({ error: "Payment could not be verified." }, { status: 500 });
  if (!payment) return Response.json({ error: "Payment record not found." }, { status: 404 });

  const { data: booking } = await db
    .from("bookings")
    .select("id, patient_id, total_amount, patients!inner(mobile)")
    .eq("id", payment.booking_id).maybeSingle();
  const patient = Array.isArray(booking?.patients) ? booking?.patients[0] : booking?.patients;
  if (!booking || mobile(patient?.mobile) !== patientMobile) return Response.json({ error: "Payment details do not match." }, { status: 403 });

  // Never trust the order id supplied by the browser; use our stored gateway_order_id.
  if (payment.gateway_order_id !== callbackOrderId) return Response.json({ error: "Payment order mismatch." }, { status: 400 });
  if (payment.status === "received") return Response.json({ verified: true, status: "received" });

  const expected = await hmac(RAZORPAY_KEY_SECRET, `${payment.gateway_order_id}|${paymentId}`);
  if (!safeEqual(expected, signature)) return Response.json({ error: "Invalid payment signature." }, { status: 400 });

  const { error: updateError } = await db.from("payments").update({
    gateway_payment_id: paymentId,
    gateway_signature: signature,
    transaction_reference: paymentId,
    gateway_metadata: { verification: "checkout_signature" },
  }).eq("id", payment.id);
  if (updateError) return Response.json({ error: "Payment verification could not be stored." }, { status: 500 });

  // Do not mark the payment received here. The captured/order.paid webhook remains the source of truth.
  return Response.json({ verified: true, status: "awaiting_capture_confirmation" });
});
