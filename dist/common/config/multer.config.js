"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.multerConfig = void 0;
const multer_1 = require("multer");
const path_1 = require("path");
exports.multerConfig = {
    storage: (0, multer_1.diskStorage)({
        destination: './uploads/temp',
        filename: (req, file, cb) => {
            const randomName = Array(32)
                .fill(null)
                .map(() => Math.round(Math.random() * 16).toString(16))
                .join('');
            cb(null, `${randomName}${(0, path_1.extname)(file.originalname)}`);
        },
    }),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        cb(null, true);
    },
};
//# sourceMappingURL=multer.config.js.map