import type {SellerOperation} from '../api';
export type OperationPhase='checking'|'confirmation'|'submitting'|'waiting'|'complete'|'failed';
export type PendingSellerOperation={kind:string;state:'sending'|'uncertain'};
const timeFormatter=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function formatOperationTime(value:string){return Number.isNaN(Date.parse(value))?'':timeFormatter.format(new Date(value));}
export function operationLabel(kind:string){return ({listing:'出品',shipping_code:'発送コード取得',register_package:'専用資材登録・コード取得',ship_notice:'発送通知',message_sync:'メッセージ取得',message_send:'メッセージ送信'} as Record<string,string>)[kind]??'操作';}
export default function OperationProgress({phase,note,verifiedAt,title}:{phase:OperationPhase|null;note:string;verifiedAt:string|null;title?:string}){
 if(!phase)return null;
 const heading=title??{checking:'出品内容を確認中',confirmation:'出品の確認待ち',submitting:'Amazonへ送信中',waiting:'Amazonの反映を確認中',complete:'Amazon登録完了',failed:'登録を完了できませんでした'}[phase];
 const formatted=verifiedAt?formatOperationTime(verifiedAt):'';
 return <div className="operation-progress" data-phase={phase} role="status" aria-live="polite" aria-atomic="true">
  <strong>{heading}</strong>
  {phase==='complete'&&formatted&&<div>完了日時：<time dateTime={verifiedAt!}>{formatted}</time></div>}
  {note&&<div>{note}</div>}
 </div>;
}
export function SellerOperationProgress({operation,pending}:{operation?:SellerOperation;pending:PendingSellerOperation|null}){
 if(!operation&&!pending)return null;
 const label=operationLabel(pending?.kind??operation!.kind);
 const checking=operation?.status==='uncertain'&&['queued','running'].includes(String(operation.result.read_check_state));
 const phase:OperationPhase=pending?(pending.state==='sending'?'submitting':'waiting'):operation!.status==='succeeded'?'complete':operation!.status==='failed'?'failed':operation!.status==='running'?'submitting':'waiting';
 const state=pending?(pending.state==='sending'?'依頼を送信中':'結果の確認が必要'):checking?'出品済み商品を確認中':({queued:'実行待ち',running:'実行中',succeeded:'完了',failed:'停止',uncertain:'結果の確認が必要'} as const)[operation!.status];
 const note=pending?'':typeof operation?.result.last_check_note==='string'?operation.result.last_check_note:typeof operation?.result.note==='string'?operation.result.note:'';
 return <OperationProgress phase={phase} title={label+(phase==='complete'?'完了':'：'+state)} note={note} verifiedAt={pending?null:operation?.finished_at??null}/>;
}
