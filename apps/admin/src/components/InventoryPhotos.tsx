import { useEffect, useState } from 'react';
import { readReviewPhotos } from '../reviewPhotos';

export default function InventoryPhotos({ itemId, sku, id }: { itemId: string; sku: string; id: string }) {
  const [photos, setPhotos] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    readReviewPhotos(itemId).then(result => {
      if (active) setPhotos(result.photos);
    }).catch(() => {
      if (active) setError('商品写真を取得できませんでした。');
    });
    return () => { active = false; };
  }, [itemId, revision]);

  function reload() {
    setPhotos(null);
    setError('');
    setRevision(value => value + 1);
  }

  return <section id={id} aria-label={`${sku}の商品写真`}>
    {error && <div className="error" role="alert">{error} <button type="button" className="btn" onClick={reload}>再読み込み</button></div>}
    {!error && photos === null && <p role="status">写真を読み込み中…</p>}
    {photos?.length === 0 && <p className="muted">登録された商品写真はありません。</p>}
    {!!photos?.length && <div className="photo-review-gallery inventory-photo-gallery">
      {photos.map((url, index) => <a href={url} target="_blank" rel="noopener noreferrer" key={index}>
        <img src={url} alt={`商品写真 ${index + 1}`} loading="lazy"
          onError={() => setError('商品写真の一部を表示できませんでした。')} />
      </a>)}
    </div>}
  </section>;
}
