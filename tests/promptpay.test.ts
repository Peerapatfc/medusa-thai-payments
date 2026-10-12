import { createHmac } from "crypto"
import { describe, expect, it, vi } from "vitest"
import { toSubunit } from "../src/lib/amount"
import { verifyOmiseSignature } from "../src/lib/signature"
import { PromptPayProviderService } from "../src/providers/promptpay/service"

const SECRET_B64 = Buffer.from("super-secret").toString("base64")

function charge(over: Record<string, unknown> = {}) {
  return {
    id: "chrg_test_1",
    object: "charge",
    amount: 12550,
    currency: "THB",
    status: "pending",
    metadata: { session_id: "payses_1" },
    expires_at: "2030-01-01T00:00:00Z",
    source: { scannable_code: { image: { download_uri: "https://qr.example/1.svg" } } },
    ...over,
  }
}

function mockFetch(...responses: Array<{ body: unknown; status?: number }>) {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce({ ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body })
  }
  return fn
}

function provider(fetchImpl: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return new PromptPayProviderService({}, { secretKey: "skey_test_x", fetch: fetchImpl as any, ...extra })
}

function sign(body: string, ts: number, secret = SECRET_B64) {
  return createHmac("sha256", Buffer.from(secret, "base64")).update(`${ts}.${body}`).digest("hex")
}

describe("amount", () => {
  it("converts major units to satang without float drift", () => {
    expect(toSubunit(125.5)).toBe(12550)
    expect(toSubunit(0.29)).toBe(29)
    expect(toSubunit("20")).toBe(2000)
    expect(toSubunit({ numeric: 99.99 } as any)).toBe(9999)
  })
})

describe("verifyOmiseSignature", () => {
  const body = '{"key":"charge.complete"}'
  const now = 1_800_000_000
  it("accepts a valid signature", () => {
    expect(
      verifyOmiseSignature({ secret: SECRET_B64, rawBody: body, signatureHeader: sign(body, now), timestampHeader: String(now), now })
    ).toBe(true)
  })
  it("accepts either signature during secret rotation", () => {
    const header = `deadbeef,${sign(body, now)}`
    expect(verifyOmiseSignature({ secret: SECRET_B64, rawBody: body, signatureHeader: header, timestampHeader: String(now), now })).toBe(true)
  })
  it("rejects tampered body, wrong secret, and stale timestamps", () => {
    const sig = sign(body, now)
    expect(verifyOmiseSignature({ secret: SECRET_B64, rawBody: body + " ", signatureHeader: sig, timestampHeader: String(now), now })).toBe(false)
    expect(
      verifyOmiseSignature({ secret: Buffer.from("other").toString("base64"), rawBody: body, signatureHeader: sig, timestampHeader: String(now), now })
    ).toBe(false)
    expect(verifyOmiseSignature({ secret: SECRET_B64, rawBody: body, signatureHeader: sig, timestampHeader: String(now), now: now + 301 })).toBe(false)
  })
  it("rejects missing headers", () => {
    expect(verifyOmiseSignature({ secret: SECRET_B64, rawBody: body, now })).toBe(false)
  })
})

describe("PromptPayProviderService", () => {
  it("validates options", () => {
    expect(() => PromptPayProviderService.validateOptions({})).toThrow(/secretKey/)
    expect(() => PromptPayProviderService.validateOptions({ secretKey: "k", qrExpiresInMinutes: 5000 })).toThrow()
    expect(() => PromptPayProviderService.validateOptions({ secretKey: "k" })).not.toThrow()
  })

  it("creates a PromptPay charge in satang with the session id in metadata", async () => {
    const f = mockFetch({ body: charge() })
    const out = await provider(f).initiatePayment({ amount: 125.5, currency_code: "thb", data: { session_id: "payses_1" } })

    const [url, init] = f.mock.calls[0]
    expect(url).toBe("https://api.omise.co/charges")
    const form = new URLSearchParams(init.body)
    expect(form.get("amount")).toBe("12550")
    expect(form.get("currency")).toBe("THB")
    expect(form.get("source[type]")).toBe("promptpay")
    expect(form.get("metadata[session_id]")).toBe("payses_1")
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("skey_test_x:").toString("base64")}`)

    expect(out.id).toBe("chrg_test_1")
    expect(out.data).toMatchObject({ charge_id: "chrg_test_1", qr_image_url: "https://qr.example/1.svg", amount: 12550 })
  })

  it("rejects non-THB currencies", async () => {
    await expect(provider(mockFetch()).initiatePayment({ amount: 10, currency_code: "usd" })).rejects.toThrow(/THB/)
  })

  it("sends expires_at when qrExpiresInMinutes is set", async () => {
    const f = mockFetch({ body: charge() })
    await provider(f, { qrExpiresInMinutes: 15 }).initiatePayment({ amount: 100, currency_code: "thb" })
    expect(new URLSearchParams(f.mock.calls[0][1].body).get("expires_at")).toBeTruthy()
  })

  it("surfaces Omise API errors", async () => {
    const f = mockFetch({ status: 400, body: { object: "error", code: "invalid_charge", message: "amount is too small" } })
    await expect(provider(f).initiatePayment({ amount: 1, currency_code: "thb" })).rejects.toThrow("amount is too small")
  })

  it.each([
    ["successful", "captured"],
    ["pending", "pending"],
    ["failed", "error"],
    ["expired", "error"],
    ["reversed", "canceled"],
  ])("maps charge status %s to %s", async (omise, medusa) => {
    const f = mockFetch({ body: charge({ status: omise }) })
    const out = await provider(f).authorizePayment({ data: { charge_id: "chrg_test_1" } })
    expect(out.status).toBe(medusa)
  })

  it("issues a new charge when the cart total changes, and reuses it otherwise", async () => {
    const existing = { charge_id: "chrg_test_1", amount: 12550, session_id: "payses_1" }
    const same = mockFetch()
    const kept = await provider(same).updatePayment({ amount: 125.5, currency_code: "thb", data: existing })
    expect(same).not.toHaveBeenCalled()
    expect(kept.data).toBe(existing)

    const changed = mockFetch({ body: charge({ id: "chrg_test_2", amount: 20000 }) })
    const fresh = await provider(changed).updatePayment({ amount: 200, currency_code: "thb", data: existing })
    expect(fresh.data).toMatchObject({ charge_id: "chrg_test_2", amount: 20000 })
  })

  describe("refunds", () => {
    // Opn: "PromptPay charges cannot be voided or refunded through Omise" (confirmed against the sandbox).
    it("fails with a clear message by default and never calls Opn", async () => {
      const f = mockFetch()
      await expect(provider(f).refundPayment({ amount: 50, data: { charge_id: "chrg_test_1" } })).rejects.toThrow(
        /cannot be refunded through Opn Payments/
      )
      expect(f).not.toHaveBeenCalled()
    })

    it("records a manual refund without calling Opn when allowManualRefunds is set", async () => {
      const f = mockFetch()
      const p = provider(f, { allowManualRefunds: true })
      const first = await p.refundPayment({ amount: 50, data: { charge_id: "chrg_test_1" } })
      const second = await p.refundPayment({ amount: 20.5, data: first.data })
      expect(f).not.toHaveBeenCalled()
      const refunds = second.data?.manual_refunds as Array<{ amount: number }>
      expect(refunds.map((r) => r.amount)).toEqual([50, 20.5])
      expect(second.data?.charge_id).toBe("chrg_test_1")
    })
  })

  it("reports Opn API failures as Medusa errors with the real reason", async () => {
    const f = mockFetch({ status: 400, body: { object: "error", code: "failed_refund", message: "charge can't be refunded" } })
    await expect(provider(f).getPaymentStatus({ data: { charge_id: "chrg_test_1" } })).rejects.toThrow("Opn Payments: charge can't be refunded")
  })

  it("refuses to capture an unpaid charge", async () => {
    const f = mockFetch({ body: charge({ status: "pending" }) })
    await expect(provider(f).capturePayment({ data: { charge_id: "chrg_test_1" } })).rejects.toThrow(/pending/)
  })

  describe("webhooks", () => {
    const event = { object: "event", key: "charge.complete", data: { object: "charge", id: "chrg_test_1" } }

    it("returns captured with the session id when the charge succeeded", async () => {
      const f = mockFetch({ body: charge({ status: "successful" }) })
      const res = await provider(f).getWebhookActionAndData({ data: event, rawData: JSON.stringify(event), headers: {} })
      expect(res).toEqual({ action: "captured", data: { session_id: "payses_1", amount: 125.5 } })
    })

    it("trusts Omise's API, not the webhook body", async () => {
      const lying = { ...event, data: { ...event.data, status: "successful" } }
      const f = mockFetch({ body: charge({ status: "pending" }) })
      const res = await provider(f).getWebhookActionAndData({ data: lying, rawData: "{}", headers: {} })
      expect(res.action).toBe("not_supported")
    })

    it("maps failed and expired charges to failed", async () => {
      const f = mockFetch({ body: charge({ status: "expired" }) })
      const res = await provider(f).getWebhookActionAndData({ data: event, rawData: "{}", headers: {} })
      expect(res.action).toBe("failed")
    })

    it("ignores other events and charges without a session id", async () => {
      const p1 = provider(mockFetch())
      expect((await p1.getWebhookActionAndData({ data: { key: "charge.create" }, rawData: "{}", headers: {} })).action).toBe("not_supported")
      const p2 = provider(mockFetch({ body: charge({ status: "successful", metadata: {} }) }))
      expect((await p2.getWebhookActionAndData({ data: event, rawData: "{}", headers: {} })).action).toBe("not_supported")
    })

    it("rejects bad signatures and accepts good ones when a secret is configured", async () => {
      const raw = JSON.stringify(event)
      const ts = Math.floor(Date.now() / 1000)

      const bad = provider(mockFetch(), { webhookSecret: SECRET_B64 })
      const rejected = await bad.getWebhookActionAndData({
        data: event,
        rawData: raw,
        headers: { "Omise-Signature": "nope", "Omise-Signature-Timestamp": String(ts) },
      })
      expect(rejected.action).toBe("failed")

      const good = provider(mockFetch({ body: charge({ status: "successful" }) }), { webhookSecret: SECRET_B64 })
      const accepted = await good.getWebhookActionAndData({
        data: event,
        rawData: raw,
        headers: { "omise-signature": sign(raw, ts), "omise-signature-timestamp": String(ts) },
      })
      expect(accepted.action).toBe("captured")
    })
  })
})
