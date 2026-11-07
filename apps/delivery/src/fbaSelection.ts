import {isFbaChannel,isSeparateAccessory} from '@bussan/shared';
import type {DeliveryTask,Staff} from '@bussan/shared';

export function canSelectFbaItem(task:DeliveryTask,staff:Staff,readOnly=false):boolean {
 return !readOnly && isFbaChannel(task.sales_channel) && task.status==='商品登録前'
  && (!task.is_accessory||isSeparateAccessory(task))
  && (staff.role==='admin'||task.deliverer_id===staff.id);
}

export function fbaSelectionAccount(task:Pick<DeliveryTask,'sales_channel'>):'FBA1'|'FBA2' {
 return /[2２]$/.test(task.sales_channel??'')?'FBA2':'FBA1';
}
