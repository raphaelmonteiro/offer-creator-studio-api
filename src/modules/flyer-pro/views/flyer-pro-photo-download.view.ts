import type { RegisteredPhoto } from '../../gallery/gallery-photo-import.service';
import { isSmallPhoto } from '../domain/flyer-pro-photo-search-rules';
import type { PhotoDownloadResponseDto } from '../dto/flyer-pro-photo-download-response.dto';

/** A resposta de B2: a foto registrada na Galeria, com `small` pela medida do arquivo baixado. */
export const toPhotoDownloadView = (photo: RegisteredPhoto): PhotoDownloadResponseDto => ({
  imageUrl: photo.url,
  imageId: photo.imageId,
  width: photo.width,
  height: photo.height,
  small: isSmallPhoto(photo.width, photo.height),
});
