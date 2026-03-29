export class PixabayImageDto {
  pixabayId: number;
  thumbnailUrl: string;
  previewUrl: string;
  fullUrl: string;
  width: number;
  height: number;
}

export class ImageSearchResponseDto {
  searchTerm: string;
  images: PixabayImageDto[];
}
