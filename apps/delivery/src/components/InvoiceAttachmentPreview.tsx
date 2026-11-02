import type { InvoiceReceipt } from '@bussan/shared';

export default function InvoiceAttachmentPreview({file}:{file:InvoiceReceipt}) {
 return file.mime_type.startsWith('image/')?<img className="invoice-review-attachment" src={file.url} alt={file.original_name}/>:<object className="invoice-review-pdf" data={file.url} type="application/pdf" aria-label={file.original_name}><a href={file.url} target="_blank" rel="noreferrer">{file.original_name}</a></object>;
}
