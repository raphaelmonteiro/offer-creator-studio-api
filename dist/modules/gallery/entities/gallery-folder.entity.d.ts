import { GalleryImage } from './gallery-image.entity';
export declare class GalleryFolder {
    id: string;
    name: string;
    color: string | null;
    images: GalleryImage[];
    createdAt: Date;
    updatedAt: Date;
}
