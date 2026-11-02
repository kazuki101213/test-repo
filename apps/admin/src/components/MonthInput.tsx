import { useRef } from 'react';
import type { InputHTMLAttributes } from 'react';

export default function MonthInput({ value, disabled, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const picker = useRef<HTMLInputElement>(null);
  const month = value == null ? '' : String(value);
  function openPicker() {
    if (disabled || !picker.current) return;
    if (typeof picker.current.showPicker === 'function') picker.current.showPicker();
    else picker.current.focus();
  }
  return <span className="calendar-control calendar-month-control">
    <span className="calendar-month-field"><span className="calendar-month-value" aria-hidden="true">{month}</span>
      <input {...props} ref={picker} type="month" value={value} disabled={disabled} />
    </span>
    <button type="button" className="calendar-button" aria-label={`${props['aria-label'] ?? '月選択'}のカレンダーを開く`} title="カレンダーを開く" disabled={disabled} onClick={openPicker}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
    </button>
  </span>;
}
