-- CuratioCare UPI payment layer (additive / backward-compatible)
-- This migration is intentionally not applied to production by this change.

alter table public.payments
  add column if not exists gateway_order_id text,
  add column if not exists gateway_payment_id text,
  add column if not exists gateway_signature text,
  add column if not exists gateway_event_id text,
  add column if not exists receipt_number text,
  add column if not exists settlement_status text not null default 'pending',
  add column if not exists settled_at timestamptz,
  add column if not exists failure_reason text,
  add column if not exists refund_id text,
  add column if not exists refunded_at timestamptz,
  add column if not exists gateway_metadata jsonb not null default '{}'::jsonb;

alter table public.payments
  drop constraint if exists payments_settlement_status_check;

alter table public.payments
  add constraint payments_settlement_status_check
  check (settlement_status in ('pending','settled','reversed','unknown'));

create unique index if not exists payments_gateway_order_id_uidx
  on public.payments (gateway_order_id)
  where gateway_order_id is not null;

create unique index if not exists payments_gateway_payment_id_uidx
  on public.payments (gateway_payment_id)
  where gateway_payment_id is not null;

create unique index if not exists payments_gateway_event_id_uidx
  on public.payments (gateway_event_id)
  where gateway_event_id is not null;

create unique index if not exists payments_receipt_number_uidx
  on public.payments (receipt_number)
  where receipt_number is not null;

create index if not exists payments_booking_id_created_at_idx
  on public.payments (booking_id, created_at desc);

comment on column public.payments.gateway_order_id is 'Gateway order identifier; server-generated and never trusted from the browser.';
comment on column public.payments.gateway_payment_id is 'Gateway payment identifier returned after payment.';
comment on column public.payments.gateway_signature is 'Verified checkout signature retained for audit.';
comment on column public.payments.gateway_event_id is 'Webhook event id used for idempotent processing.';
comment on column public.payments.receipt_number is 'Stable CuratioCare payment receipt identifier.';
comment on column public.payments.settlement_status is 'Independent settlement state; does not imply customer payment state.';
