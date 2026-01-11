import { diskStorage } from 'multer';
import { extname } from 'path';

export const multerConfig = {
  storage: diskStorage({
    destination: './uploads/temp',
    filename: (req, file, cb) => {
      const randomName = Array(32)
        .fill(null)
        .map(() => Math.round(Math.random() * 16).toString(16))
        .join('');
      cb(null, `${randomName}${extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB em bytes
  },
  fileFilter: (req, file, cb) => {
    // Aceitar todos os tipos de arquivo por enquanto
    // Você pode adicionar validação de tipo aqui se necessário
    cb(null, true);
  },
};
