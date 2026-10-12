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
npm test          # 23 unit tests, HTTP is mocked
npm run typecheck
npm run build
```

## Status

- [x] Unit-tested against mocked Opn responses
- [x] Verified in a running Medusa 2.21.2 instance against a local mock of the Omise API: QR session, signed webhook, cart completion, payment capture, refund, and a forged webhook being ignored
- [ ] Verified against a real Opn sandbox account
- [ ] Example storefront (planned: `thai-commerce-storefront`)

## License

MIT
