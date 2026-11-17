export const japanMarketplace = 'A1VC38T7YXB528';

export type SaleOrderItem = {
  order_id: string;
  line_id: string;
  sku: string;
  asin: string;
  product_title: string;
  fulfillment: 'AMAZON' | 'MERCHANT';
  purchased_at: string;
};

export function confirmedOrderItems(order: any): SaleOrderItem[] {
  const fulfillment = order?.fulfillment?.fulfilledBy;
  const status = order?.fulfillment?.fulfillmentStatus;
  if (order?.salesChannel?.marketplaceId !== japanMarketplace ||
      (fulfillment !== 'AMAZON' && fulfillment !== 'MERCHANT') ||
      !['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED'].includes(status) ||
      typeof order.orderId !== 'string' || !/^\d{3}-\d{7}-\d{7}$/.test(order.orderId) ||
      typeof order.createdTime !== 'string' || !Number.isFinite(Date.parse(order.createdTime)) ||
      !Array.isArray(order.orderItems)) return [];
  return order.orderItems.flatMap((item: any) => {
    const sku = item?.product?.sellerSku, asin = item?.product?.asin, lineId = item?.orderItemId;
    if (typeof sku !== 'string' || !sku.trim() || sku.length > 160 ||
        typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin) ||
        typeof lineId !== 'string' || !lineId || lineId.length > 80 ||
        item.fulfillment?.fulfillmentStatus === 'CANCELLED') return [];
    return [{ order_id: order.orderId, line_id: lineId, sku, asin, fulfillment,
      purchased_at: new Date(order.createdTime).toISOString(),
      product_title: typeof item.product.title === 'string' ? item.product.title.slice(0, 100) : '' }];
  });
}
