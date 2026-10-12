import type { ChangeEvent, InputHTMLAttributes } from 'react';

function formatDate(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length < 4) return digits;
  if (digits.length === 4) return `${digits}-`;
  if (digits.length < 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  if (digits.length === 6) return `${digits.slice(0, 4)}-${digits.slice(4)}-`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

export default function DateInput({ onChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & { onChange?: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return <input {...props} type="text" inputMode="numeric" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" placeholder="YYYY-MM-DD" onChange={event => {
    const input = event.currentTarget;
    const raw = input.value;
    const formatted = formatDate(raw);
    if (formatted !== raw) {
      const caret = input.selectionStart ?? raw.length;
      const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, '').length;
      const nextCaret = digitsBeforeCaret + (digitsBeforeCaret >= 4 ? 1 : 0) + (digitsBeforeCaret >= 6 ? 1 : 0);
      input.value = formatted;
      requestAnimationFrame(() => input.setSelectionRange(nextCaret, nextCaret));
    }
    onChange?.(event);
  }} />;
}
