import { useRef } from 'react';
import type { ChangeEvent, FocusEvent, InputHTMLAttributes } from 'react';

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'onBlur'> & {
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
};

function normalizeDate(value: string, finalize = false) {
  const parts = value.split(/[-/]/);
  const hasSeparator = parts.length > 1;
  if (hasSeparator) {
    const year = (parts[0] ?? '').replace(/\D/g, '').slice(0, 4);
    const month = (parts[1] ?? '').replace(/\D/g, '').slice(0, 2);
    const day = (parts[2] ?? '').replace(/\D/g, '').slice(0, 2);
    if (year.length < 4) return year;
    const paddedMonth = month.length === 1 && (parts.length > 2 || finalize) ? `0${month}` : month;
    const paddedDay = day.length === 1 && (parts.length > 2 || finalize) ? `0${day}` : day;
    let result = `${year}-${paddedMonth}`;
    if (parts.length > 2 || day) result += `-${paddedDay}`;
    return result;
  }

  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length < 4) return digits;
  if (digits.length === 4) return `${digits}-`;
  if (digits.length === 5) return `${digits.slice(0, 4)}-${finalize ? `0${digits.slice(4)}` : digits.slice(4)}`;
  if (digits.length === 6) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-`;
  const month = digits.slice(4, 6);
  const day = digits.slice(6);
  return `${digits.slice(0, 4)}-${month}-${finalize && day.length === 1 ? `0${day}` : day}`;
}

function withValue(event: ChangeEvent<HTMLInputElement>, value: string) {
  if (event.currentTarget.value !== value) event.currentTarget.value = value;
  return event;
}

export default function DateInput({ onChange, onBlur, value, disabled, min, max, className, style, ...props }: DateInputProps) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const rawValue = value == null ? '' : String(value);
  const textValue = normalizeDate(rawValue, rawValue.length >= 5);

  const handleTextChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    const formatted = normalizeDate(raw);
    const caret = event.currentTarget.selectionStart ?? raw.length;
    const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, '').length;
    const nextCaret = Math.min(formatted.length, digitsBeforeCaret + (digitsBeforeCaret > 4 ? 1 : 0) + (digitsBeforeCaret > 6 ? 1 : 0));
    withValue(event, formatted);
    onChange?.(event);
    requestAnimationFrame(() => event.currentTarget?.setSelectionRange(nextCaret, nextCaret));
  };

  const handleTextBlur = (event: FocusEvent<HTMLInputElement>) => {
    const formatted = normalizeDate(event.currentTarget.value, true);
    const changed = event.currentTarget.value !== formatted;
    event.currentTarget.value = formatted;
    if (changed) onChange?.(event as unknown as ChangeEvent<HTMLInputElement>);
    onBlur?.(event);
  };

  const openPicker = () => {
    if (disabled) return;
    const picker = pickerRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!picker) return;
    if (typeof picker.showPicker === 'function') picker.showPicker();
    else picker.focus();
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <input
        {...props}
        className={className}
        style={style}
        type="text"
        inputMode="numeric"
        pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
        placeholder={props.placeholder ?? 'YYYY-MM-DD'}
        value={textValue}
        disabled={disabled}
        onChange={handleTextChange}
        onBlur={handleTextBlur}
      />
      <button type="button" aria-label="カレンダーを開く" title="カレンダーを開く" disabled={disabled} onClick={openPicker} style={{ flex: '0 0 auto', padding: '0.25rem 0.4rem', lineHeight: 1, color: 'currentColor', cursor: disabled ? 'default' : 'pointer' }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
      </button>
      <input ref={pickerRef} type="date" value={textValue} min={min} max={max} tabIndex={-1} aria-hidden="true" onChange={onChange} style={{ position: 'fixed', opacity: 0, width: 1, height: 1, pointerEvents: 'none' }} />
    </span>
  );
}
