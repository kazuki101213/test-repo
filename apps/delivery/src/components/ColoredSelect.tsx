import type { SelectHTMLAttributes } from 'react';

// Keep the native picker, keyboard controls, validation and change event.
export default function ColoredSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <div className="colored-select"><select {...props} /></div>;
}
