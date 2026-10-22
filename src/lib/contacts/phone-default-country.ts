/**
 * Apply an explicitly chosen default country to a phone number typed
 * without its country code — contract requirement 3 (international
 * phone validation for bulk imports).
 *
 * The importer still requires an international number in the end
 * (`parseInternationalPhone` needs the leading `+`, see issue #586 for
 * why guessing is dangerous). This helper only fills the country in
 * when the person importing has *chosen* one in the dialog, so a
 * Pakistani student list in national format imports correctly:
 *
 *   "0310 5478805"   → "+923105478805"   (trunk 0 replaced by +92)
 *   "3105478805"     → "+923105478805"   (no trunk 0)
 *   "923105478805"   → "+923105478805"   (country code without +)
 *   "0092310…"       → "+92310…"         (00 international prefix)
 *   "+44 20 7946…"   → unchanged         (already international)
 *
 * Anything it can't confidently convert is returned unchanged and is
 * then reported as an invalid phone by the existing validation.
 */
export interface DefaultCountry {
  /** ISO 3166-1 alpha-2, for display. */
  iso: string;
  /** Country calling code, digits only. */
  callingCode: string;
  /** Length of the national significant number (without trunk 0). */
  nationalLength: number;
}

export const DEFAULT_COUNTRIES: Record<string, DefaultCountry> = {
  PK: { iso: 'PK', callingCode: '92', nationalLength: 10 },
};

export function applyDefaultCountry(raw: string, country: DefaultCountry | null): string {
  const trimmed = raw.trim();
  if (!country || trimmed === '' || trimmed.startsWith('+')) return trimmed;

  const digits = trimmed.replace(/[\s().-]/g, '');
  if (!/^\d+$/.test(digits)) return trimmed;

  const { callingCode, nationalLength } = country;

  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0') && digits.length === nationalLength + 1) {
    return `+${callingCode}${digits.slice(1)}`;
  }
  if (digits.startsWith(callingCode) && digits.length === callingCode.length + nationalLength) {
    return `+${digits}`;
  }
  if (digits.length === nationalLength) return `+${callingCode}${digits}`;

  return trimmed;
}
