import type { InvoiceReceipt } from './receipts';
import { PDFDocument } from 'pdf-lib';
import html2canvas from 'html2canvas';
/** Screen-only preview transforms must not scale the exported A4 pages. */
function resetPreview(doc: Document) {
  doc.querySelectorAll<HTMLElement>('.document-preview').forEach(node => { node.style.height = 'auto'; });
  doc.querySelectorAll<HTMLElement>('.document-preview-content').forEach(node => { node.style.transform = 'none'; node.style.marginLeft = '0'; });
}
/** Merge rendered Japanese document pages and original PDFs without resizing PDF pages. */
export async function buildInvoicePdf(elements: HTMLElement[], files: InvoiceReceipt[]): Promise<Uint8Array> {
  // Load PDF dependencies with the app so an open page survives a later deployment.
  await document.fonts.ready;
  const pdf = await PDFDocument.create();
  for (const element of elements) {
    await Promise.all(Array.from(element.querySelectorAll('img')).map(image => image.decode()));
    const canvas = await html2canvas(element, {
      scale: 3, backgroundColor: '#fff', useCORS: true, logging: false,
      onclone: (doc, clone) => {
        resetPreview(doc);
        clone.style.margin = '0';
        // Use the preview's photo slots with an aspect-preserving background during capture.
        clone.querySelectorAll<HTMLImageElement>('.receipt-photo-sheet figure img').forEach(image => {
          const photo = doc.createElement('div');
          photo.style.cssText = 'flex:1; min-height:0; width:100%; background-size:contain; background-repeat:no-repeat; background-position:center';
          photo.style.backgroundImage = 'url(' + JSON.stringify(image.currentSrc || image.src) + ')';
          image.replaceWith(photo);
        });
      },
    });
    const image = element.classList.contains('receipt-photo-sheet')
      ? await pdf.embedJpg(canvas.toDataURL('image/jpeg', .94))
      : await pdf.embedPng(canvas.toDataURL('image/png'));
    const page = pdf.addPage([595.28, 841.89]);
    const scale = Math.min(538.58 / image.width, 785.19 / image.height);
    const width = image.width * scale; const height = image.height * scale;
    page.drawImage(image, { x: (595.28 - width) / 2, y: 841.89 - 28.35 - height, width, height });
    canvas.width = 0; canvas.height = 0;
  }
  for (const [index, file] of files.entries()) {
    if (file.mime_type !== 'application/pdf') continue;
    let source; let original: ArrayBuffer;
    try {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error('download');
      original = await response.arrayBuffer();
      source = await PDFDocument.load(original);
      if (!source.getPageCount()) throw new Error('empty');
    } catch { throw new Error(`「${file.original_name}」をPDFとして開けません。破損していない、パスワードのないPDFを選び直してください。`); }
    const pages = await pdf.copyPages(source, source.getPageIndices());
    pages.forEach(page => pdf.addPage(page));
    await pdf.attach(original!, String(index + 1) + '_' + file.original_name, { mimeType: 'application/pdf', description: file.description || file.original_name });
  }
  return pdf.save();
}
export async function downloadInvoicePdf(elements: HTMLElement[], files: InvoiceReceipt[], name: string): Promise<void> {
  const bytes = await buildInvoicePdf(elements, files);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Separate uploaded PDF pages for the review spread; the original stays unchanged. */
export async function splitInvoicePdfPages(bytes: ArrayBuffer): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(bytes);
  if (!source.getPageCount()) throw new Error('PDFにページがありません。');
  const pages: Uint8Array[] = [];
  for (const index of source.getPageIndices()) {
    const page = await PDFDocument.create();
    const [copy] = await page.copyPages(source, source.getPageIndices().slice(index, index + 1));
    page.addPage(copy!);
    pages.push(await page.save());
  }
  return pages;
}
