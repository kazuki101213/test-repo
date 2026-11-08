import JsBarcode from 'jsbarcode';
import {labelPaper, labelPosition, labelSlots, type LabelCalibration} from './fbaLabelLayout';

export interface FbaProductLabel {
  id: string;
  fnsku: string;
  condition: string;
  sku: string;
  image: string;
}

/** Remove the cost suffix only from the inventory SKU format, including accessory/return suffixes. */
export function fbaLabelSku(sku: string): string {
  return /^(\d+[a-z]*[-_][a-z]{4}[-_]\d{8})[-_]\d+$/i.exec(sku.trim())?.[1] ?? '';
}

function FbaBarcode({value}: {value: string}) {
  const result: {encodings?: {data: string}[]} = {};
  JsBarcode(result, value, {format: 'CODE128', displayValue: false, margin: 0});
  const bars = result.encodings?.[0]?.data ?? '';
  return <svg className="fba-label-barcode" aria-hidden="true" viewBox={`0 0 ${bars.length} 1`} preserveAspectRatio="none">
    {Array.from(bars, (bar, x) => bar === '1' ? <rect key={x} x={x} width="1" height="1"/> : null)}
  </svg>;
}

export function FbaProductLabelSheet({labels, calibration, firstPosition = 1, alignment = false, onPhotoError}: {
  labels: FbaProductLabel[];
  calibration: LabelCalibration;
  firstPosition?: number;
  alignment?: boolean;
  onPhotoError?: () => void;
}) {
  const firstSlot = firstPosition - 1;
  const pages = alignment ? 1 : Math.ceil((labels.length + firstSlot) / labelSlots);

  return <div className="fba-label-sheet">
    {Array.from({length: pages}, (_, page) =>
      <div className="fba-label-page" key={page} style={{width: `${labelPaper.width}mm`, height: `${labelPaper.height}mm`}}>
        {Array.from({length: labelSlots}, (_, slot) => {
          const position = labelPosition(slot, calibration);
          if (alignment) {
            return <div className="fba-label-guide" key={slot} style={position}>{slot + 1}</div>;
          }
          const label = labels[page * labelSlots + slot - firstSlot];
          if (!label) return null;
          return <article className="fba-product-label" key={label.id} style={position}>
            <FbaBarcode value={label.fnsku}/>
            <div className="fba-label-details">
              <img src={label.image} alt="" onError={onPhotoError}/>
              <div className="fba-label-identity">
                <strong>{label.fnsku}</strong>
                <span>{label.condition}</span>
                <span className="fba-label-sku">SKU {label.sku}</span>
              </div>
            </div>
          </article>;
        })}
      </div>
    )}
  </div>;
}
