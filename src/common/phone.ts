/** A Nigerian mobile number: 0803..., +234803... (spaces and dashes allowed). Returns +234803..., or null. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const m = /^(?:\+?234|0)([789][01]\d{8})$/.exec(digits);
  return m ? `+234${m[1]}` : null;
}

/** +2348031234567 -> +234803***4567, for showing a number back without exposing all of it. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.length > 8 ? `${phone.slice(0, 7)}***${phone.slice(-4)}` : '***';
}
