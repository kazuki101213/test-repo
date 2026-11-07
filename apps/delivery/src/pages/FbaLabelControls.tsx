import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {getSupabase, inventorySerial, type DeliveryTask} from '@bussan/shared';
import {deliveryErrorMessage} from '../errors';
import {FbaProductLabelSheet, fbaLabelSku, type FbaProductLabel} from './FbaProductLabelSheet';

async function fetchLabel(item: DeliveryTask, withSku: boolean, withPhoto: boolean): Promise<FbaProductLabel> {
  const sku = withSku ? fbaLabelSku(item.sku) : '';
  if (withSku && !sku) throw new Error('金額を除いたSKUに変換できません。SKUの表示を外すか、在庫でSKUをご確認ください。');
  const {data, error} = await getSupabase().functions.invoke('amazon-fba-labels', {
    body: {itemId: item.id, expectedSku: item.sku, expectedChannel: item.sales_channel, includePhoto: withPhoto},
  });
  if (error) {
    const detail = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(detail?.error || 'Amazonの商品ラベル情報を取得できませんでした。');
  }
  if (!/^X[A-Z0-9]{9}$/.test(data?.fnsku ?? '') || typeof data?.title !== 'string' || typeof data?.condition !== 'string') {
    throw new Error('商品ラベル情報を確認できません。');
  }
  const image = withPhoto ? data.image || item.reference_image_url : null;
  if (withPhoto && !image) throw new Error('Amazonの商品写真を取得できません。写真の表示を外すと印刷できます。');
  return {id: item.id, fnsku: data.fnsku, title: data.title, condition: data.condition, sku, image};
}

export default function FbaLabelControls({items}: {items: DeliveryTask[]}) {
  const [withSku, setWithSku] = useState(true), [withPhoto, setWithPhoto] = useState(true);
  const [labels, setLabels] = useState<FbaProductLabel[] | null>(null);
  const [file, setFile] = useState<{name: string; url: string} | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [shippingError, setShippingError] = useState('');
  const [photoError, setPhotoError] = useState(false);
  const labelDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latestFile = useRef(0);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (labels && labelDialog.current && !labelDialog.current.open) labelDialog.current.showModal();
  }, [labels]);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);

  async function preview() {
    if (busy) return;
    setError(''); setPhotoError(false); setBusy(true);
    try {
      const result: FbaProductLabel[] = [];
      for (const item of items) {
        try {
          result.push(await fetchLabel(item, withSku, withPhoto));
        } catch (cause) {
          throw new Error(inventorySerial(item) + '：' + deliveryErrorMessage(cause));
        }
      }
      setLabels(result);
    } catch (cause) {
      setError(deliveryErrorMessage(cause));
    } finally { setBusy(false); }
  }

  async function selectShippingPdf(pdf: File) {
    const request = ++latestFile.current;
    setFile(null); setShippingError('');
    const signature = await pdf.slice(0, 5).text().catch(() => '');
    if (latestFile.current !== request) return;
    if (signature !== '%PDF-') { setShippingError('セラーセントラルで発行したPDFファイルを選んでください。'); return; }
    setFile({name: pdf.name, url: URL.createObjectURL(new Blob([pdf], {type: 'application/pdf'}))});
  }

  function printProducts() {
    if ([...(sheet.current?.querySelectorAll('img') ?? [])].some(img => !img.complete || !img.naturalWidth)) {
      setError('写真の読み込みが終わってから、もう一度お試しください。'); return;
    }
    setError('');
    window.print();
  }

  return <section className="fba-label-controls" aria-label="配送・ラベル">
    <h4>配送・ラベル</h4>
    <div className="fba-label-actions">
      <label><input type="checkbox" checked={withSku} disabled={busy} onChange={event => setWithSku(event.target.checked)}/> 金額を除いたSKU</label>
      <label><input type="checkbox" checked={withPhoto} disabled={busy} onChange={event => setWithPhoto(event.target.checked)}/> Amazonの商品写真</label>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void preview()}>{busy ? '取得中…' : '商品ラベル'}</button>
    </div>
    {error && !labels && <p role="alert" className="error">{error}</p>}
    <div className="fba-label-actions">
      <input ref={fileInput} type="file" accept=".pdf,application/pdf" hidden onChange={event => {
        const pdf = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (pdf) void selectShippingPdf(pdf);
      }}/>
      <button type="button" className="btn" onClick={() => fileInput.current?.click()}>配送ラベルPDFを選択</button>
      {file && <><a className="btn" href={file.url} target="_blank" rel="noopener noreferrer">配送ラベルを開いて印刷</a><span>{file.name}</span></>}
    </div>
    {shippingError && <p role="alert" className="error">{shippingError}</p>}
    <p className="muted">セラーセントラルで発行済みの配送ラベルPDFを選択し、開いたPDFの印刷メニューを使います。</p>
    {labels && createPortal(<>

      <dialog ref={labelDialog} className="fba-label-dialog" aria-label="商品ラベルの印刷" onClose={() => { setLabels(null); setError(''); }}>
        <div className="fba-label-dialog-actions">
          <button type="button" className="btn primary" onClick={printProducts} disabled={photoError}>印刷</button>
          <button type="button" className="btn" onClick={() => labelDialog.current?.close()}>閉じる</button>
          <span>A4・24面（66 × 33.9 mm）／倍率100%</span>
        </div>
        {(error || photoError) && <p role="alert" className="error">{photoError ? '写真を読み込めません。写真の表示を外すか、もう一度取得してください。' : error}</p>}
        <div className="fba-label-paper" ref={sheet}>
          <FbaProductLabelSheet labels={labels} onPhotoError={() => setPhotoError(true)}/>
        </div>
      </dialog>
      <div className="fba-print-copy" aria-hidden="true"><FbaProductLabelSheet labels={labels}/></div>
    </>, document.body)}
  </section>;
}
