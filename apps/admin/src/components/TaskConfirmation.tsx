import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Request = { label: string; action: () => Promise<void>; notice?: string };
function Confirmation({ request, onClose }: { request: Request; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    cancel.current?.focus();
    return () => { element?.close(); };
  }, []);
  function close() { if (!lock.current) onClose(); }
  async function execute() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await request.action(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="admin-task-confirmation" aria-label="操作の確認"
    onCancel={event => { event.preventDefault(); close(); }}>
    <h3>実行しますか</h3><p>{request.label}</p>{request.notice && <p>{request.notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="admin-task-confirmation-actions">
      <button type="button" className="btn primary" disabled={busy} onClick={() => void execute()}>{busy ? '実行中…' : 'はい'}</button>
      <button ref={cancel} type="button" className="btn" disabled={busy} onClick={close}>キャンセル</button>
    </div>
  </dialog>, document.body);
}
export function useTaskConfirmation() {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef(false);
  function ask(label: string, action: () => Promise<void>, notice?: string) {
    if (pending.current) return;
    pending.current = true; setRequest({ label, action, notice });
  }
  function close() { pending.current = false; setRequest(null); }
  return { ask, pending: !!request, confirmation: request ? <Confirmation request={request} onClose={close} /> : null };
}
