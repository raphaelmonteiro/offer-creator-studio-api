import { GalleryFolder } from './gallery-folder.entity';
export declare class GalleryImage {
    id: string;
    filename: string;
    url: string;
    thumbnailUrl: string | null;
    mimeType: string;
    size: number;
    folderId: string | null;
    folder: GalleryFolder | null;
    createdAt: Date;
    updatedAt: Date;
}
