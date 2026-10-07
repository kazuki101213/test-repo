export const PRODUCTION_PLAN={
  "id": "2026-10-07-automatic-purchase-production",
  "mode": "tracking",
  "cancelled": false,
  "inspectLists": false,
  "retryTracking": false,
  "purchaseImportEnabled": true,
  "bootstrapPurchases": false,
  "forcePurchaseRetry": false,
  "inspectPurchases": false,
  "profiles": {
    "ba92b386-e0bc-48be-b3b6-ca9550fa1a2d": [
      {
        "id": "auctions-1",
        "name": "Green",
        "listUrl": "https://auctions.yahoo.co.jp/my/won"
      },
      {
        "id": "flea-1",
        "name": "Green",
        "listUrl": "https://paypayfleamarket.yahoo.co.jp/my/purchase"
      },
      {
        "id": "rakuma-1",
        "name": "Greenさんのマイページ",
        "listUrl": "https://fril.jp/buy"
      }
    ],
    "f29f12b6-35f2-4e9f-8312-a8321ddf3c12": [
      {
        "id": "mercari-1",
        "name": "ふわふわさん",
        "listUrl": "https://jp.mercari.com/mypage/purchases"
      },
      {
        "id": "auctions-2",
        "name": "ふわふわさん",
        "listUrl": "https://auctions.yahoo.co.jp/my/won"
      },
      {
        "id": "flea-2",
        "name": "ふわふわさん",
        "listUrl": "https://paypayfleamarket.yahoo.co.jp/my/purchase"
      }
    ],
    "51502a66-28a6-4af0-81ea-660e63d8b66c": [
      {
        "id": "mercari-2",
        "name": "siro",
        "listUrl": "https://jp.mercari.com/mypage/purchases"
      }
    ]
  },
  "recipes": {
    "mercari": {
      "scope": "main",
      "verified": true
    },
    "auctions": {
      "scope": "main",
      "verified": true
    },
    "flea": {
      "scope": "main",
      "verified": false,
      "trackingEnabled": true
    },
    "rakuma": {
      "scope": "main",
      "verified": false,
      "trackingEnabled": true
    }
  },
  "evidence": {
    "mercari": "m94624390123 buyer/pending, tracking 623036958471, inventory count 1; 0.1.14",
    "auctions": "m1246130716 buyer/pending, tracking 500450963865; real diagnostic",
    "flea": "User enabled tracking; purchase/account and completed pages observed; pending write not yet observed",
    "rakuma": "User enabled tracking; account/purchase list observed; user reports no active trades; pending write not yet observed"
  },
  "unsupported": [],
  "trackingPolicy": "inventory-first",
  "inventoryFirst": {
    "time": "01:00",
    "timezone": "Asia/Tokyo",
    "month": "calendar",
    "receipt": false
  }
};
