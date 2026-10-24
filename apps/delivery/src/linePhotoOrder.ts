import type {ItemPhoto} from './api';

// IDs, rather than array positions or expiring signed URLs, identify photos.
export function linePhotoOrder(photos:ItemPhoto[], publishedIds:string[] = []):ItemPhoto[]{
 const remaining=new Map(photos.map(photo=>[photo.id,photo]));
 const ordered:ItemPhoto[]=[];
 for(const id of publishedIds){const photo=remaining.get(id);if(photo){ordered.push(photo);remaining.delete(id);}}
 return [...ordered,...remaining.values()];
}
