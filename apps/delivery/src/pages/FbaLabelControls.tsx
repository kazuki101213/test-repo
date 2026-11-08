import {useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {getSupabase, inventorySerial, type DeliveryTask} from '@bussan/shared';
import {deliveryErrorMessage} from '../errors';
import {FbaProductLabelSheet, fbaLabelSku, type FbaProductLabel} from './FbaProductLabelSheet';
import {calibrationFields, calibrationInput, defaultCalibration, labelSlots, parseCalibration, readCalibration, saveCalibration, type CalibrationInput} from './fbaLabelLayout';

type LabelItem = Pick<DeliveryTask, 'id'|'sku'|'sales_channel'>;
async function fetchLabel(item: LabelItem): Promise<FbaProductLabel> {
  const sku = fbaLabelSku(item.sku);
  if (!sku) throw new Error('金額を除いたSKUに変換できません。在庫でSKUをご確認ください。');
  const {data, error} = await getSupabase().functions.invoke('amazon-fba-labels', {
    body: {itemId: item.id, expectedSku: item.sku, expectedChannel: item.sales_channel, includePhoto: true},
  });
  if (error) {
    const detail = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(detail?.error || 'Amazonの商品ラベル情報を取得できませんでした。');
  }
  if (!/^X[A-Z0-9]{9}$/.test(data?.fnsku ?? '') || typeof data?.condition !== 'string') {
    throw new Error('商品ラベル情報を確認できません。');
  }
  if (typeof data.image !== 'string' || !data.image) throw new Error('Amazonの商品写真を取得できません。もう一度「商品ラベル」を押してください。');
  return {id: item.id, fnsku: data.fnsku, condition: data.condition, sku, image: data.image};
}

export default function FbaLabelControls({items,productOnly=false,shippingLabel}: {items: LabelItem[];productOnly?:boolean;shippingLabel?:ReactNode}) {
  const [labels, setLabels] = useState<FbaProductLabel[] | null>(null);
  const [printMode, setPrintMode] = useState<'product' | 'alignment' | null>(null);
  const [firstPosition, setFirstPosition] = useState(1);
  const [calibration, setCalibration] = useState(readCalibration);
  const [adjustments, setAdjustments] = useState(() => calibrationInput(calibration));
  const [file, setFile] = useState<{name: string; url: string} | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [shippingError, setShippingError] = useState('');
  const [photoError, setPhotoError] = useState(false);
  const labelDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latestFile = useRef(0);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (printMode && labelDialog.current && !labelDialog.current.open) labelDialog.current.showModal();
  }, [printMode]);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);

  async function preview() {
    if (busy) return;
    setError(''); setPhotoError(false); setBusy(true);
    try {
      const result: FbaProductLabel[] = [];
      for (const item of items) {
        try {
          result.push(await fetchLabel(item));
        } catch (cause) {
          throw new Error(inventorySerial(item) + '：' + deliveryErrorMessage(cause));
        }
      }
      setLabels(result);
      setFirstPosition(1);
      setPrintMode('product');
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

  const alignment = printMode === 'alignment';
  const calibrationValid = parseCalibration(adjustments) !== null;

  function updateAdjustments(next: CalibrationInput) {
    setAdjustments(next);
    const values = parseCalibration(next);
    if (values) {
      setCalibration(values);
      saveCalibration(values);
    }
  }

  function printSheet() {
    if (!calibrationValid) return;
    if (!alignment && [...(sheet.current?.querySelectorAll('img') ?? [])].some(img => !img.complete || !img.naturalWidth)) {
      setError('写真の読み込みが終わってから、もう一度お試しください。');
      return;
    }
    setError('');
    window.print();
  }

  return <section className="fba-label-controls" aria-label="配送・ラベル">
    {!productOnly&&<h4>配送・ラベル</h4>}
    <div className="fba-label-actions">
      <button type="button" className="btn primary" disabled={busy||!items.length} onClick={() => void preview()}>{busy ? '取得中…' : '商品ラベル'}</button>
      {shippingLabel}
      <button type="button" className="btn" disabled={busy} onClick={() => setPrintMode('alignment')}>位置合わせシート</button>
    </div>
    {error && !printMode && <p role="alert" className="error">{error}</p>}
    {!productOnly&&<><div className="fba-label-actions">
      <input ref={fileInput} type="file" accept=".pdf,application/pdf" hidden onChange={event => {
        const pdf = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (pdf) void selectShippingPdf(pdf);
      }}/>
      <button type="button" className="btn" onClick={() => fileInput.current?.click()}>配送ラベルPDFを選択</button>
      {file && <><a className="btn" href={file.url} target="_blank" rel="noopener noreferrer">配送ラベルを開いて印刷</a><span>{file.name}</span></>}
    </div>
    {shippingError && <p role="alert" className="error">{shippingError}</p>}
    <p className="muted">セラーセントラルで発行済みの配送ラベルPDFを選択し、開いたPDFの印刷メニューを使います。</p></>}
    {printMode && createPortal(<>
      <dialog ref={labelDialog} className="fba-label-dialog" aria-label={alignment ? '商品ラベルの位置合わせ' : '商品ラベルの印刷'} onClose={() => {
        setPrintMode(null);
        setLabels(null);
        setError('');
      }}>
        <div className="fba-label-dialog-actions">
          <button type="button" className="btn primary" onClick={printSheet} disabled={!calibrationValid || (!alignment && photoError)}>印刷</button>
          <button type="button" className="btn" onClick={() => labelDialog.current?.close()}>閉じる</button>
        </div>
        <p className="fba-label-print-instructions">A4・24面（66 × 33.9 mm）／倍率100%・余白なし・ヘッダーとフッターなし</p>
        <fieldset className="fba-label-adjustment">
          <legend>印刷位置の調整</legend>
          <div className="fba-label-adjustment-fields">
            {calibrationFields.map(({key, label, positive, limit}) =>
              <label key={key}>
                <span>{label}（mm）</span>
                <input type="number" inputMode="decimal" min={-limit} max={limit} step={0.1} value={adjustments[key]}
                  onChange={event => updateAdjustments({...adjustments, [key]: event.target.value})} />
                <small>±{limit} mm、{positive}</small>
              </label>
            )}
          </div>
          <div className="fba-label-dialog-actions">
            <button type="button" className="btn" onClick={() => updateAdjustments(calibrationInput(defaultCalibration))}>調整をリセット</button>
            {!alignment && <label>印刷開始位置 <select value={firstPosition} onChange={event => setFirstPosition(Number(event.target.value))}>
              {Array.from({length: labelSlots}, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
            </select></label>}
          </div>
          {!calibrationValid && <p role="alert" className="error">調整値を表示範囲内で、0.1 mm刻みで入力してください。</p>}
        </fieldset>
        {alignment && <p className="fba-label-print-instructions">普通紙に印刷してラベル用紙に重ね、枠のずれを確認してください。</p>}
        {(error || (!alignment && photoError)) && <p role="alert" className="error">{!alignment && photoError ? 'Amazonの商品写真を読み込めません。画面を閉じて、もう一度「商品ラベル」を押してください。' : error}</p>}
        <div className="fba-label-paper" ref={sheet}>
          <FbaProductLabelSheet labels={labels ?? []} calibration={calibration} firstPosition={firstPosition} alignment={alignment} onPhotoError={() => setPhotoError(true)}/>
        </div>
      </dialog>
      <div className="fba-print-copy" aria-hidden="true">
        <FbaProductLabelSheet labels={labels ?? []} calibration={calibration} firstPosition={firstPosition} alignment={alignment}/>
      </div>
    </>, document.body)}
  </section>;
}
