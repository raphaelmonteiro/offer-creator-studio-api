"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFileInterceptor = exports.fileUploadOptions = void 0;
const platform_express_1 = require("@nestjs/platform-express");
exports.fileUploadOptions = {
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
};
const createFileInterceptor = (fieldName = 'file') => {
    return (0, platform_express_1.FileInterceptor)(fieldName, exports.fileUploadOptions);
};
exports.createFileInterceptor = createFileInterceptor;
//# sourceMappingURL=multer.util.js.map