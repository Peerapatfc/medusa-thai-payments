/**
 * Medusa passes amounts in major units (e.g. 125.50 THB). Omise expects the
 * smallest currency unit (satang), so 125.50 THB becomes 12550.
 */
import type { BigNumberInput } from "@medusajs/types"

export type AmountInput = BigNumberInput

export function toNumber(amount: AmountInput): number {
  if (typeof amount === "object" && amount !== null) {
    const o = amount as { numeric?: number; value?: string | number }
    const n = o.numeric ?? Number(o.value)
    if (!Number.isFinite(n)) throw new Error("Invalid amount")
    return n
  }
  const n = Number(amount)
  if (!Number.isFinite(n)) throw new Error("Invalid amount")
  return n
}

export function toSubunit(amount: AmountInput): number {
  return Math.round(toNumber(amount) * 100)
}

export function fromSubunit(subunit: number): number {
  return subunit / 100
}
