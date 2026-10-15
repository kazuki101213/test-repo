import type { InvoiceReceipt } from './receipts';
/** Merge rendered Japanese document pages and original PDFs without resizing PDF pages. */
export async function buildInvoicePdf(elements: HTMLElement[], files: InvoiceReceipt[]): Promise<Uint8Array> {
  const [{ PDFDocument, rgb }, { default: html2canvas }] = await Promise.all([import('pdf-lib'), import('html2canvas')]);
  await document.fonts.ready;
  const pdf = await PDFDocument.create();
  for (const element of elements) {
    if (element.classList.contains('receipt-photo-sheet')) {
      const page = pdf.addPage([595.28, 841.89]);
      const cellWidth = (538.58 - 11.34) / 2; const cellHeight = (785.19 - 11.34) / 2;
      const figures = Array.from(element.querySelectorAll('figure'));
      for (const [index, figure] of figures.entries()) {
        const source = figure.querySelector('img'); const caption = figure.querySelector('figcaption');
        if (!source || !caption) throw new Error('添付写真を読み込めません。');
        await source.decode();
        const x = 28.35 + (index % 2) * (cellWidth + 11.34);
        const top = 841.89 - 28.35 - Math.floor(index / 2) * (cellHeight + 11.34);
        page.drawRectangle({ x, y: top - cellHeight, width: cellWidth, height: cellHeight, borderWidth: .5, borderColor: rgb(.7, .7, .7) });
        const titleCanvas = await html2canvas(caption, { scale: 3, backgroundColor: '#fff', logging: false, windowWidth: 1280,
          onclone: (_doc, clone) => { clone.style.width = '85mm'; clone.style.maxWidth = 'none'; clone.style.minHeight = '0'; },
        });
        const title = await pdf.embedPng(titleCanvas.toDataURL('image/png'));
        const titleWidth = cellWidth - 12; const titleHeight = title.height * titleWidth / title.width;
        page.drawImage(title, { x: x + 6, y: top - 6 - titleHeight, width: titleWidth, height: titleHeight });
        titleCanvas.width = 0; titleCanvas.height = 0;
        const canvas = document.createElement('canvas'); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
        const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('写真をPDFに変換できません。');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0);
        const photo = await pdf.embedJpg(canvas.toDataURL('image/jpeg', .94));
        const availableHeight = cellHeight - titleHeight - 18; const scale = Math.min(titleWidth / photo.width, availableHeight / photo.height);
        const width = photo.width * scale; const height = photo.height * scale;
        page.drawImage(photo, { x: x + (cellWidth - width) / 2, y: top - 12 - titleHeight - (availableHeight + height) / 2, width, height });
        canvas.width = 0; canvas.height = 0;
      }
      continue;
    }
    await Promise.all(Array.from(element.querySelectorAll('img')).map(image => image.decode()));
    const canvas = await html2canvas(element, {
      scale: 3, backgroundColor: '#fff', useCORS: true, logging: false, windowWidth: 1280,
      onclone: (_doc, clone) => { clone.style.width = '190mm'; clone.style.margin = '0'; clone.style.maxWidth = 'none'; clone.style.minHeight = '270mm'; },
    });
    const image = await pdf.embedPng(canvas.toDataURL('image/png'));
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