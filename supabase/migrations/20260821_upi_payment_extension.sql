-- CuratioCare UPI payment extension
-- Additive-only migration. Existing payment columns, enums, RLS and cash flow are preserved.

alter table public.payments
  add column if not exists gateway text,
  add column if not exists gateway_order_id text,
  add column if not exists gateway_payment_id text,
  add column if not exists receipt_number text,
  add column if not exists settlement_status text not null default 'unknown',
  add column if not exists settled_at timestamptz,
  add column if not exists gateway_event_id text,
  add column if not exists gateway_event_created_at timestamptz,
  add column if not exists failure_reason text,
  add column if not exists refund_reference text,
  add column if not exists refunded_at timestamptz;

-- Constrain only the new settlement field; do not modify existing payment enums.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payments_settlement_status_check'
      and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_settlement_status_check
      check (settlement_status in ('unknown','pending','settled','reversed'));
  end if;
end $$;

-- Gateway identifiers must not map to multiple CuratioCare payment rows.
create unique index if not exists payments_gateway_order_id_uidx
  on public.payments (gateway_order_id)
  where gateway_order_id is not null;

create unique index if not exists payments_gateway_payment_id_uidx
  on public.payments (gateway_payment_id)
  where gateway_payment_id is not null;

create unique index if not exists payments_receipt_number_uidx
  on public.payments (receipt_number)
  where receipt_number is not null;

create unique index if not exists payments_gateway_event_id_uidx
  on public.payments (gateway_event_id)
  where gateway_event_id is not null;

create index if not exists payments_booking_id_idx
  on public.payments (booking_id);

create index if not exists payments_created_at_idx
  on public.payments (created_at desc);

comment on column public.payments.gateway is 'Payment gateway identifier; null for legacy/manual payments.';
comment on column public.payments.gateway_order_id is 'Gateway order identifier created server-side.';
comment on column public.payments.gateway_payment_id is 'Verified gateway payment identifier.';
comment on column public.payments.receipt_number is 'Stable CuratioCare payment receipt number.';
comment on column public.payments.gateway_event_id is 'Last processed gateway event identifier used for idempotency.';
