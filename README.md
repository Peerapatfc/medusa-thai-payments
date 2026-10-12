# medusa-thai-payments

PromptPay QR payments for [Medusa v2](https://docs.medusajs.com), powered by [Opn Payments (Omise)](https://docs.opn.ooo/promptpay).

Thai shoppers expect to pay by scanning a PromptPay QR with their banking app. This package adds a Medusa payment provider that creates the QR charge, tracks it, and completes the cart when the customer pays.

## How it works

```
Storefront            Medusa (this provider)                 Opn Payments
    │  init payment session    │                                  │
    ├─────────────────────────►│  POST /charges (promptpay)       │
    │                          ├─────────────────────────────────►│
    │◄─ data.qr_image_url ─────┤◄──────── charge + QR image ──────┤
    │                          │                                  │
    │  customer scans QR in their banking app                     │
    │                          │◄──── webhook: charge.complete ───┤
    │                          │  verify HMAC signature           │
    │                          │  GET /charges/:id  (source of    │
    │                          ├─────────────────────────────────►│   truth)
    │◄─ cart completes ────────┤  action = "captured"             │
```

Design notes:

- **Amounts**: Medusa uses major units (125.50 THB); Opn uses satang (12550). Conversion is rounded, not floored, to avoid float drift.
- **Webhooks are not trusted for status.** After verifying the signature, the provider re-fetches the charge and acts on what the API returns.
- **Signature check** follows Opn's scheme: HMAC-SHA256 over `<timestamp>.<raw body>`, base64-decoded secret, constant-time compare, 5-minute replay window, and support for two signatures during secret rotation.
- **Changed cart total → new QR.** A QR code encodes a fixed amount, so `updatePayment` creates a fresh charge when the total changes and reuses the existing one otherwise.
- **No capture step.** PromptPay settles on payment, so a successful charge maps straight to `captured`.
- **Cancel is a no-op.** Opn cannot void a PromptPay charge; an unpaid QR just expires.
- **The webhook is a backup, not the only path.** Completing the cart asks Opn for the charge's status itself, so an order is still created if a webhook is late or lost.
- THB only. Other currencies are rejected.

## Install

```bash
npm install medusa-thai-payments
```

## Configure

In `medusa-config.ts`:

```ts
module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-thai-payments/providers/promptpay",
            id: "promptpay",
            options: {
              secretKey: process.env.OMISE_SECRET_KEY,       // skey_test_... or skey_...
              webhookSecret: process.env.OMISE_WEBHOOK_SECRET, // base64 secret, recommended
              qrExpiresInMinutes: 30,                        // optional, max 1440
              // allowManualRefunds: true,                   // optional, see "Refunds" below
              // apiBaseUrl: "http://localhost:4010",        // optional: point at a mock Omise in tests
            },
          },
        ],
      },
    },
  ],
})
```

Then enable the provider (`pp_promptpay_promptpay`) for your Thai region in Medusa Admin.

Webhook URL to register in the Opn dashboard (event `charge.complete`):

```
https://<your-backend>/hooks/payment/promptpay_promptpay
```

> The route is `/hooks/payment/{identifier}_{id}`, confirmed on Medusa 2.21.2.
>
> PromptPay must be enabled on your Opn account first (Thai merchants only; Opn asks you to request it).

## Refunds

Opn Payments **does not refund PromptPay charges**: its docs say "PromptPay charges cannot be voided or refunded through Omise", and a sandbox charge comes back with `refundable: false`. So by default, refunding a payment in Medusa fails with a clear message and nothing is sent to Opn.

If you pay customers back yourself (for example by bank transfer), set `allowManualRefunds: true`. Medusa then records the refund (and keeps the amounts in the payment's `data.manual_refunds`), but **no money moves**. Paying the customer is up to you.

## Webhooks, and why you want one

Register `https://<your-backend>/hooks/payment/promptpay_promptpay` in the Opn dashboard. Once it is set up, **Medusa creates the order itself a few seconds after Opn reports `charge.complete`** (about 6 seconds in a sandbox run). The storefront does not have to ask for completion.

Without a webhook the order is still created, but only when something calls `POST /store/carts/:id/complete`, and in Medusa 2.21 **each failed attempt consumes an order number** (`display_id`). In a sandbox run, about 80 early attempts moved the next order from #29 to #109; no orders were duplicated, the numbering just has gaps. So:

- With a webhook: watch the payment session with cheap reads and call `complete` once the session is no longer `pending` (what the example storefront does). Keep one slow `complete` call (every 30 seconds) as a safety net.
- Without one: poll `complete` as rarely as your UX allows.

**Signatures:** if your Opn account signs webhooks, set `webhookSecret` and the provider verifies `Omise-Signature`. In the sandbox account used for testing, Opn sent **no** signature header (only `User-Agent: Omise/2019-05-29`), so the secret was left unset. If you set `webhookSecret` but Opn does not sign, every webhook is ignored. The provider never trusts the webhook body for status either way: it re-reads the charge from Opn.

## Storefront usage

After you initiate the payment session, the QR image URL is in the session data:

```ts
const session = paymentCollection.payment_sessions.find((s) => s.provider_id === "pp_promptpay_promptpay")
const qrUrl = session.data.qr_image_url as string
```

Render it as an `<img>`, then keep calling `POST /store/carts/:id/complete` every couple of seconds. It is safe to poll: it only succeeds after Opn's webhook has reached Medusa and the payment is captured, and answers 400 until then. The charge must never be trusted from the browser.

Working examples:

- [`thai-commerce-storefront`](https://github.com/Peerapatfc/thai-commerce-storefront): a small Next.js checkout that shows the QR and polls (`storefront/components/checkout/payment-step.tsx`).
- The official [Medusa Next.js starter](https://github.com/medusajs/nextjs-starter-medusa) does not know PromptPay. It lists the provider by its raw id and leaves "Place order" disabled. [This patch](https://github.com/Peerapatfc/thai-commerce-storefront/blob/main/docs/nextjs-starter-promptpay.patch) (about 80 lines) adds the QR button; tested against starter commit `9818886`.

## Develop

```bash
npm install
npm test          # 25 unit tests, HTTP is mocked
npm run typecheck
npm run build
```

## Status

- [x] Unit-tested (25 tests, HTTP mocked)
- [x] Verified in a running Medusa 2.21.2 instance, first against a local mock of the Omise API
- [x] **Verified against the real Opn Payments sandbox** (test key): PromptPay charge creation, QR image (an SVG poster that can be loaded straight into an `<img>`), `metadata` round trip, status, expiry, and an order created after the charge was marked paid in the dashboard
- [x] **Real Opn webhooks received** through a tunnel: `charge.create` and `charge.complete` reached Medusa, and Medusa created the order by itself about 6 seconds after `charge.complete`
- [ ] Webhook **signature** verified against a real Opn signature (the sandbox account sent none, so this is only checked against signatures generated locally)
- [x] Example storefront: [`thai-commerce-storefront`](https://github.com/Peerapatfc/thai-commerce-storefront)

## License

MIT
