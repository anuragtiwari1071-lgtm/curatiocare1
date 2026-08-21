import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID") || "";
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "*")
  .split(",").map((x) => x.trim()).filter(Boolean);

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes("*") ? "*" :
    (ALLOWED_ORIGINS.includes(origin) ? origin : "");
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

function normalizeMobile(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").slice(-10);
}

function safeReceipt(bookingCode: string) {
  const clean = bookingCode.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `CUR-${clean}-${Date.now().toString(36).toUpperCase()}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Only POST requests are allowed." }, 405);
  if (!SERVICE_ROLE_KEY || !RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return json(req, { error: "Online payment is not configured yet." }, 503);
  }

  const origin = req.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.includes("*") && !ALLOWED_ORIGINS.includes(origin)) {
    return json(req, { error: "Origin not allowed." }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "Invalid JSON." }, 400); }

  const bookingId = String(body?.booking_id || "").trim();
  const mobile = normalizeMobile(body?.mobile);
  if (!bookingId || !/^[0-9a-f-]{36}$/i.test(bookingId)) {
    return json(req, { error: "A valid booking is required." }, 400);
  }
  if (!/^\d{10}$/.test(mobile)) return json(req, { error: "Valid booking mobile is required." }, 400);

  const { data: booking, error: bookingError } = await db
    .from("bookings")
    .select("id, booking_code, patient_id, total_amount, patients!inner(full_name,mobile)")
    .eq("id", bookingId)
    .maybeSingle();
  if (bookingError) return json(req, { error: "Booking could not be verified." }, 500);
  if (!booking) return json(req, { error: "Booking not found." }, 404);

  const patient = Array.isArray(booking.patients) ? booking.patients[0] : booking.patients;
  if (normalizeMobile(patient?.mobile) !== mobile) return json(req, { error: "Booking details do not match." }, 403);

  const amount = Number(booking.total_amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 500000) {
    return json(req, { error: "Booking amount is invalid." }, 400);
  }

  const { data: existing } = await db
    .from("payments")
    .select("id, amount, status, gateway_order_id, receipt_number")
    .eq("booking_id", bookingId)
    .eq("method", "upi")
    .in("status", ["pending", "received"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.status === "received") {
    return json(req, {
      already_paid: true,
      payment_id: existing.id,
      receipt_number: existing.receipt_number,
    });
  }

  if (existing?.gateway_order_id) {
    return json(req, {
      already_paid: false,
      payment_id: existing.id,
      order_id: existing.gateway_order_id,
      amount: Number(existing.amount),
      currency: "INR",
      key_id: RAZORPAY_KEY_ID,
      receipt_number: existing.receipt_number,
    });
  }

  const amountPaise = Math.round(amount * 100);
  const receipt = safeReceipt(String(booking.booking_code));
  const auth = btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);

  const gatewayResponse = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: { booking_id: booking.id, booking_code: booking.booking_code },
    }),
  });

  if (!gatewayResponse.ok) {
    console.error("Razorpay order creation failed", gatewayResponse.status);
    return json(req, { error: "Payment order could not be created." }, 502);
  }

  const order: any = await gatewayResponse.json();

  const { data: payment, error: paymentError } = await db
    .from("payments")
    .insert({
      booking_id: booking.id,
      amount,
      method: "upi",
      status: "pending",
      transaction_reference: order.id,
      gateway_order_id: order.id,
      receipt_number: receipt,
      settlement_status: "pending",
      gateway_metadata: { currency: "INR" },
    })
    .select("id, gateway_order_id, receipt_number")
    .single();

  if (paymentError) {
    console.error("Payment record insert failed", paymentError);
    return json(req, { error: "Payment could not be initialized." }, 500);
  }

  return json(req, {
    already_paid: false,
    payment_id: payment.id,
    order_id: order.id,
    amount,
    amount_paise: amountPaise,
    currency: "INR",
    key_id: RAZORPAY_KEY_ID,
    receipt_number: payment.receipt_number,
    patient_name: patient.full_name,
  });
});
