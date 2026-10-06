import { labelTone } from '@bussan/shared';

export default function ColoredLabel({ value }: { value: string }) {
  return <span className="colored-label" data-tone={labelTone(value)}>{value}</span>;
}
