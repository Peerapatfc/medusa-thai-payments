import { createHmac, timingSafeEqual } from "crypto"

const DEFAULT_TOLERANCE_SECONDS = 300

export type SignatureInput = {
  secret: string // base64-encoded webhook secret from the Opn Payments dashboard
  rawBody: string | Buffer
  signatureHeader?: string // Omise-Signature (may hold two comma-separated signatures)
  timestampHeader?: string // Omise-Signature-Timestamp (unix seconds)
  toleranceSeconds?: number
  now?: number // unix seconds, injectable for tests
}

/**
 * Verifies an Omise webhook: HMAC-SHA256 over `<timestamp>.<raw body>` keyed by
 * the base64-decoded secret, hex-encoded, compared in constant time.
 */
export function verifyOmiseSignature(input: SignatureInput): boolean {
  const { secret, rawBody, signatureHeader, timestampHeader } = input
  if (!signatureHeader || !timestampHeader) return false

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
  const expected = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(`${timestampHeader}.${body}`, "utf8")
    .digest("hex")
  const expectedBuf = Buffer.from(expected, "utf8")

  return signatureHeader.split(",").some((candidate) => {
    const candidateBuf = Buffer.from(candidate.trim(), "utf8")
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)
  })
}
