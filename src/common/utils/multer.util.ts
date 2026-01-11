import { FileInterceptor } from '@nestjs/platform-express';

/**
 * Configuração padrão do Multer para uploads
 * Limite: 50MB
 */
export const fileUploadOptions = {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
};

/**
 * Helper para criar FileInterceptor com limites configurados
 */
export const createFileInterceptor = (fieldName: string = 'file') => {
  return FileInterceptor(fieldName, fileUploadOptions);
};
