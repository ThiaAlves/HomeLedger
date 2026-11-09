/** Date-only fields have no timezone; format them without shifting the calendar day. */
export function formatLocalDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC' }).format(
    new Date(value.slice(0, 10) + 'T12:00:00Z'),
  );
}
