"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateFileName = generateFileName;
exports.getFileMimeType = getFileMimeType;
exports.isValidImageFile = isValidImageFile;
exports.isValidFontFile = isValidFontFile;
const path_1 = require("path");
const uuid_1 = require("uuid");
function generateFileName(originalName) {
    const ext = (0, path_1.extname)(originalName);
    const uniqueName = `${(0, uuid_1.v4)()}${ext}`;
    return uniqueName;
}
function getFileMimeType(filename) {
    const ext = (0, path_1.extname)(filename).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}
function isValidImageFile(filename) {
    const ext = (0, path_1.extname)(filename).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}
function isValidFontFile(filename) {
    const ext = (0, path_1.extname)(filename).toLowerCase();
    return ['.ttf', '.otf', '.woff', '.woff2'].includes(ext);
}
//# sourceMappingURL=file.util.js.map