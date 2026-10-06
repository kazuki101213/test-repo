import { Children, isValidElement, type SelectHTMLAttributes } from 'react';
import { labelTone } from '@bussan/shared';

// Keep the native picker, keyboard controls, validation and change event.
export default function ColoredSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const selected = Children.toArray(props.children).find(child =>
    isValidElement<{ value?: string; children?: string }>(child) && child.type === 'option' &&
    String(child.props.value ?? child.props.children ?? '') === String(props.value ?? ''),
  );
  const label = isValidElement<{ children?: string }>(selected) ? String(selected.props.children ?? '') : String(props.value ?? '');
  return <div className="colored-select" data-tone={labelTone(label)}><select {...props} /></div>;
}
