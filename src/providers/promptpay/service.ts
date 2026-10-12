import { AbstractPaymentProvider, MedusaError } from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  PaymentSessionStatus,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/types"
import { fromSubunit, toNumber, toSubunit } from "../../lib/amount"
import { FetchLike, OmiseApiError, OmiseCharge, OmiseClient } from "../../lib/omise-client"
import { verifyOmiseSignature } from "../../lib/signature"

export type PromptPayOptions = {
  /** Omise / Opn Payments secret key (skey_...). */
  secretKey: string
  /** Base64 webhook secret. When set, webhook signatures are verified. */
  webhookSecret?: string
  /** Minutes until the QR code expires. Omise allows at most 24h (1440). */
  qrExpiresInMinutes?: number
  /**
   * Opn Payments cannot refund PromptPay charges ("PromptPay charges cannot be voided or refunded
   * through Omise"). By default a refund in Medusa fails with a clear message. Set this to true to let
   * Medusa record the refund instead, when you pay the customer back yourself (for example by bank transfer).
   */
  allowManualRefunds?: boolean
  /** Override the Omise API origin, e.g. to point at a local mock. Defaults to https://api.omise.co. */
  apiBaseUrl?: string
  /** Injected for tests. */
  fetch?: FetchLike
}

type PromptPayData = {
  charge_id: string
  status: OmiseCharge["status"]
  amount: number // subunit (satang)
  currency: string
  qr_image_url?: string
  expires_at?: string | null
  session_id?: string
}

export class PromptPayProviderService extends AbstractPaymentProvider<PromptPayOptions> {
  static identifier = "promptpay"

  protected readonly options_: PromptPayOptions
  protected readonly client_: OmiseClient

  static validateOptions(options: Record<string, unknown>): void | never {
    if (!options.secretKey || typeof options.secretKey !== "string") {
      throw new Error("medusa-thai-payments: option `secretKey` is required")
    }
    const mins = options.qrExpiresInMinutes
    if (mins !== undefined && (typeof mins !== "number" || mins < 1 || mins > 1440)) {
      throw new Error("medusa-thai-payments: `qrExpiresInMinutes` must be between 1 and 1440")
    }
  }

  constructor(container: Record<string, unknown>, options: PromptPayOptions) {
    super(container, options)
    this.options_ = options
    this.client_ = new OmiseClient(options.secretKey, options.fetch, options.apiBaseUrl)
  }

  /** Maps an Omise charge status onto a Medusa payment session status. */
  static mapStatus(status: OmiseCharge["status"]): PaymentSessionStatus {
    switch (status) {
      case "successful":
        return "captured" // PromptPay settles immediately; there is no separate capture step
      case "pending":
        return "pending"
      case "reversed":
        return "canceled"
      default:
        return "error" // failed, expired
    }
  }

  /** Turns Opn API failures into Medusa errors so Admin and the Store API show the real reason. */
  private async omise<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (e) {
      if (e instanceof OmiseApiError) {
        const type = e.status >= 400 && e.status < 500 ? MedusaError.Types.INVALID_DATA : MedusaError.Types.UNEXPECTED_STATE
        throw new MedusaError(type, `Opn Payments: ${e.message}`)
      }
      throw e
    }
  }

  private toData(charge: OmiseCharge, sessionId?: string): PromptPayData {
    return {
      charge_id: charge.id,
      status: charge.status,
      amount: charge.amount,
      currency: charge.currency,
      qr_image_url: charge.source?.scannable_code?.image?.download_uri,
      expires_at: charge.expires_at ?? null,
      session_id: sessionId ?? charge.metadata?.session_id,
    }
  }

  private chargeIdOf(data?: Record<string, unknown>): string {
    const id = data?.charge_id
    if (typeof id !== "string" || !id) throw new Error("PromptPay payment data is missing `charge_id`")
    return id
  }

  private async createCharge(amount: InitiatePaymentInput["amount"], currency: string, sessionId?: string) {
    if (currency.toLowerCase() !== "thb") {
      throw new Error("PromptPay only supports THB")
    }
    const expiresAt = this.options_.qrExpiresInMinutes
      ? new Date(Date.now() + this.options_.qrExpiresInMinutes * 60_000).toISOString()
      : undefined
    const charge = await this.omise(() => this.client_.createPromptPayCharge({
      amount: toSubunit(amount),
      currency,
      sessionId,
      expiresAt,
    }))
    return this.toData(charge, sessionId)
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const sessionId = input.data?.session_id as string | undefined
    const data = await this.createCharge(input.amount, input.currency_code, sessionId)
    return { id: data.charge_id, status: "pending", data }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const current = input.data as Partial<PromptPayData> | undefined
    // A QR code encodes a fixed amount, so a changed cart total needs a fresh charge.
    if (current?.charge_id && current.amount === toSubunit(input.amount)) {
      return { status: "pending", data: current }
    }
    const data = await this.createCharge(input.amount, input.currency_code, current?.session_id)
    return { status: "pending", data }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const { status, data } = await this.getPaymentStatus(input)
    return { status, data }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const charge = await this.omise(() => this.client_.retrieveCharge(this.chargeIdOf(input.data)))
    return {
      status: PromptPayProviderService.mapStatus(charge.status),
      data: this.toData(charge, input.data?.session_id as string | undefined),
    }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const charge = await this.omise(() => this.client_.retrieveCharge(this.chargeIdOf(input.data)))
    return { data: this.toData(charge, input.data?.session_id as string | undefined) }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    // Funds are already settled once the customer pays; just confirm with Omise.
    const charge = await this.omise(() => this.client_.retrieveCharge(this.chargeIdOf(input.data)))
    if (charge.status !== "successful") {
      throw new Error(`Cannot capture PromptPay charge ${charge.id}: status is ${charge.status}`)
    }
    return { data: this.toData(charge, input.data?.session_id as string | undefined) }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    if (!this.options_.allowManualRefunds) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "PromptPay charges cannot be refunded through Opn Payments. Refund the customer outside Medusa " +
          "(for example by bank transfer). To record such refunds in Medusa, set `allowManualRefunds: true` on the provider."
      )
    }
    // Nothing is sent to Opn: the merchant pays the customer back and Medusa only records the amount.
    const previous = Array.isArray(input.data?.manual_refunds) ? (input.data?.manual_refunds as unknown[]) : []
    return {
      data: {
        ...input.data,
        manual_refunds: [...previous, { amount: toNumber(input.amount), recorded_at: new Date().toISOString() }],
      },
    }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    // Omise cannot void a PromptPay charge; an unpaid QR simply expires.
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data }
  }

  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const { webhookSecret } = this.options_
    if (webhookSecret) {
      const headers = Object.fromEntries(
        Object.entries(payload.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
      )
      const valid = verifyOmiseSignature({
        secret: webhookSecret,
        rawBody: payload.rawData,
        signatureHeader: headers["omise-signature"],
        timestampHeader: headers["omise-signature-timestamp"],
      })
      if (!valid) return { action: "failed" }
    }

    const event = payload.data as { key?: string; data?: { id?: string; object?: string } }
    if (event.key !== "charge.complete" || event.data?.object !== "charge" || !event.data.id) {
      return { action: "not_supported" }
    }

    // Never trust the webhook body for status: re-fetch the charge from Omise.
    const chargeId = event.data.id
    const charge = await this.omise(() => this.client_.retrieveCharge(chargeId))
    const sessionId = charge.metadata?.session_id
    if (!sessionId) return { action: "not_supported" }

    const data = { session_id: sessionId, amount: fromSubunit(charge.amount) }
    switch (charge.status) {
      case "successful":
        return { action: "captured", data }
      case "failed":
      case "expired":
        return { action: "failed", data }
      default:
        return { action: "not_supported" }
    }
  }
}

export default PromptPayProviderService
