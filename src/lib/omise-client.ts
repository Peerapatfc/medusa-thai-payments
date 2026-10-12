export type OmiseChargeStatus = "pending" | "successful" | "failed" | "expired" | "reversed"

export type OmiseCharge = {
  id: string
  object: "charge"
  amount: number
  currency: string
  status: OmiseChargeStatus
  paid?: boolean
  refunded_amount?: number
  failure_code?: string | null
  failure_message?: string | null
  expires_at?: string | null
  metadata?: Record<string, string>
  source?: {
    scannable_code?: { image?: { download_uri?: string } }
  }
}

export type FetchLike = typeof fetch

export class OmiseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = "OmiseApiError"
  }
}

export class OmiseClient {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = "https://api.omise.co"
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    })
    const json = (await res.json()) as T & { object?: string; code?: string; message?: string }
    if (!res.ok || json.object === "error") {
      throw new OmiseApiError(json.message ?? `Omise request failed (${res.status})`, res.status, json.code)
    }
    return json
  }

  createPromptPayCharge(params: {
    amount: number // satang
    currency: string
    sessionId?: string
    expiresAt?: string // ISO 8601, max 24h ahead
  }): Promise<OmiseCharge> {
    const form: Record<string, string> = {
      amount: String(params.amount),
      currency: params.currency.toUpperCase(),
      "source[type]": "promptpay",
    }
    if (params.sessionId) form["metadata[session_id]"] = params.sessionId
    if (params.expiresAt) form.expires_at = params.expiresAt
    return this.request<OmiseCharge>("POST", "/charges", form)
  }

  retrieveCharge(id: string): Promise<OmiseCharge> {
    return this.request<OmiseCharge>("GET", `/charges/${encodeURIComponent(id)}`)
  }
}
