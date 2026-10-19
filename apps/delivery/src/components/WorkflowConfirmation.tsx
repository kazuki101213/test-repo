import {useEffect,useRef} from 'react';
import type {WorkflowButton} from '@bussan/shared';

export default function WorkflowConfirmation({button,busy,onConfirm,onCancel}:{button:WorkflowButton;busy:boolean;onConfirm:()=>void;onCancel:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const element=dialog.current;element?.showModal();cancel.current?.focus();return()=>element?.close();},[]);
 return <dialog ref={dialog} className="workflow-confirmation" aria-label="操作の確認" onCancel={event=>{event.preventDefault();if(!busy)onCancel();}}>
  <h3>実行しますか</h3><p>{button.label}</p>{button.confirmation&&<p>{button.confirmation}</p>}
  <div className="workflow-confirmation-buttons"><button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>{busy?'実行中…':'はい'}</button><button ref={cancel} type="button" className="btn" disabled={busy} onClick={onCancel}>キャンセル</button></div>
 </dialog>;
}
