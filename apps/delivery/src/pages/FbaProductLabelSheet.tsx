import JsBarcode from 'jsbarcode';

export interface FbaProductLabel {
  id: string;
  fnsku: string;
  title: string;
  condition: string;
  sku: string;
  image: string | null;
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

export function FbaProductLabelSheet({labels, onPhotoError}: {
  labels: FbaProductLabel[]; onPhotoError?: () => void;
}) {
  return <div className="fba-label-sheet">
    {Array.from({length: Math.ceil(labels.length / 24)}, (_, page) =>
      <div className="fba-label-page" key={page}>
        {labels.slice(page * 24, page * 24 + 24).map(label =>
          <article className="fba-product-label" key={label.id}>
            <div className="fba-label-identity">
              <FbaBarcode value={label.fnsku}/>
              <strong>{label.fnsku}</strong>
              {label.sku && <span>SKU {label.sku}</span>}
              <span className="fba-label-name">{label.title}</span>
              <span>{label.condition}</span>
            </div>
            {label.image && <img src={label.image} alt="" onError={onPhotoError}/>}
          </article>
        )}
      </div>
    )}
  </div>;
}
