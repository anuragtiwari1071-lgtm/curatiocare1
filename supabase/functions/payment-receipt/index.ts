import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((x) => x.trim()).filter(Boolean);
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes("*") ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : "");
  return {
    "Access-Control-Allow-Origin": allowed || "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors(req) });
}

function mobile(value: unknown) { return String(value ?? "").replace(/\D/g, "").slice(-10); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Only POST requests are allowed." }, 405);
  if (!SERVICE_ROLE_KEY) return json(req, { error: "Receipt service is not configured." }, 503);

  const origin = req.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.includes("*") && !ALLOWED_ORIGINS.includes(origin)) return json(req, { error: "Origin not allowed." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "Invalid JSON." }, 400); }
  const bookingId = String(body?.booking_id || "").trim();
  const patientMobile = mobile(body?.mobile);
  if (!/^[0-9a-f-]{36}$/i.test(bookingId) || !/^\d{10}$/.test(patientMobile)) {
    return json(req, { error: "Valid booking details are required." }, 400);
  }

  const { data: booking, error: bookingError } = await db
    .from("bookings")
    .select("id, booking_code, patient_id, total_amount, patients!inner(full_name,mobile)")
    .eq("id", bookingId).maybeSingle();
  if (bookingError) return json(req, { error: "Receipt could not be loaded." }, 500);
  if (!booking) return json(req, { error: "Booking not found." }, 404);
  const patient = Array.isArray(booking.patients) ? booking.patients[0] : booking.patients;
  if (mobile(patient?.mobile) !== patientMobile) return json(req, { error: "Booking details do not match." }, 403);

  const { data: payment, error: paymentError } = await db
    .from("payments")
    .select("id, amount, method, status, transaction_reference, gateway_payment_id, gateway_order_id, receipt_number, received_at, created_at, settlement_status")
    .eq("booking_id", bookingId).eq("status", "received")
    .order("received_at", { ascending: false }).limit(1).maybeSingle();
  if (paymentError) return json(req, { error: "Payment record could not be loaded." }, 500);
  if (!payment) return json(req, { error: "No verified payment receipt is available yet." }, 404);

  return json(req, {
    receipt: {
      receipt_number: payment.receipt_number,
      booking_code: booking.booking_code,
      patient_name: patient.full_name,
      amount: Number(payment.amount),
      currency: "INR",
      method: payment.method,
      status: "PAID",
      transaction_id: payment.gateway_payment_id || payment.transaction_reference,
      gateway_order_id: payment.gateway_order_id,
      paid_at: payment.received_at,
      settlement_status: payment.settlement_status,
    },
  });
});
