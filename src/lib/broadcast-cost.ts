/**
 * Client-specific MVP blended rate estimate in PKR per message.
 * Not Meta's live rate card: actual billing varies by template category,
 * destination country, and delivery.
 */
export function parseBroadcastRate(input: string): number | null {
  const value = input.trim();
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,4})?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number <= 99999 ? number : null;
}

/** Estimate in PKR, rounded to paisa. Null means the rate is unknown. */
export function estimateBroadcastCost(
  recipientCount: number,
  ratePkr: number | null,
): number | null {
  if (ratePkr === null) return null;
  if (!Number.isSafeInteger(recipientCount) || recipientCount < 0 ||
      !Number.isFinite(ratePkr) || ratePkr < 0 || ratePkr > 99999) {
    throw new RangeError('Invalid count or configured unit rate');
  }
  const total = Math.round(recipientCount * ratePkr * 100) / 100;
  if (!Number.isSafeInteger(Math.round(total * 100))) {
    throw new RangeError('Estimated total exceeds safe precision');
  }
  return total;
}
