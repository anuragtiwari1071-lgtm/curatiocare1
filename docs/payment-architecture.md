# CuratioCare UPI Payment Architecture

This document defines the isolated UPI payment implementation for CuratioCare. It is intentionally not wired into production until merchant onboarding and gateway credentials are verified.

## Goals
- UPI-only customer checkout.
- Mobile: UPI Intent/app selection.
- Desktop: Dynamic UPI QR.
- No UPI Collect/VPA-entry flow.
- Server-authoritative booking amount.
- Gateway order creation only from a trusted backend function.
- Webhook signature verification before marking a payment paid.
- Idempotent webhook processing.
- Patient receipt and admin payment ledger.
- Separate payment status from settlement status.
- Existing cash payment flow remains unchanged.

## Security rules
1. Never expose gateway secret keys in `index.html`, browser JavaScript, GitHub, or client-visible configuration.
2. Never trust an amount supplied by the browser. The backend must derive the payable amount from the existing booking/test pricing records.
3. Never mark a booking paid from a client-side success callback alone.
4. Verify gateway webhook signatures using the gateway secret stored in the server-side secret store.
5. Process a gateway event idempotently so retries cannot create duplicate receipts or state transitions.
6. Link every gateway order/payment to exactly one CuratioCare booking.
7. Do not collect or store UPI PIN, OTP, bank password, or other UPI authentication secrets.
8. Existing RLS and existing cash-payment behaviour must not be weakened.

## State model
Payment status is separate from settlement status.

Payment status:
- pending
- received
- failed
- refunded

Settlement status:
- pending
- settled
- reversed
- unknown

A successful customer payment is recorded as `received` only after trusted gateway verification. Settlement is updated independently.

## Customer flow
1. Patient completes the existing booking flow.
2. The server reads the existing booking and authoritative total amount.
3. Server creates one gateway order for that booking.
4. Mobile opens the gateway's UPI Intent/app chooser; desktop presents a dynamic QR.
5. Gateway processes the UPI payment.
6. CuratioCare receives the gateway webhook.
7. Webhook signature is verified.
8. The payment record is created/updated idempotently.
9. Booking is marked paid only after verified payment state.
10. A stable receipt number is generated and associated with the payment.
11. Patient receives the receipt; admin sees the payment in the payment ledger.

## Production gate
The implementation must remain inactive until:
- merchant/KYC onboarding is complete;
- the settlement bank account is verified by the gateway;
- live API credentials are supplied through the server-side secret mechanism;
- test-mode success, failure, retry, refresh, duplicate-webhook and refund scenarios pass;
- a real small-value transaction is manually verified after activation.
