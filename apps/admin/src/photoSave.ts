// Prepare files before a click: iPhone sharing needs an active user gesture.
export async function preparePhotoFiles(photos: Array<{ url: string }>, lot: number, signal: AbortSignal): Promise<File[]> {
  const files: File[] = [];
  for (const [index, photo] of photos.entries()) {
    const response = await fetch(photo.url, { signal });
    if (!response.ok) throw new Error('写真を読み込めませんでした。もう一度お試しください。');
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith('image/')) throw new Error('写真のデータを確認できませんでした。');
    const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
    files.push(new File([blob], `${lot}_photo_${index + 1}.${extension}`, { type: blob.type }));
  }
  return files;
}

export async function savePhotoFiles(files: File[], title: string): Promise<'share' | 'download'> {
  if (!files.length) throw new Error('保存できる写真がありません。');
  if (navigator.share && navigator.canShare?.({ files })) {
    await navigator.share({ files, title });
    return 'share';
  }
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url; link.download = file.name;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return 'download';
}
