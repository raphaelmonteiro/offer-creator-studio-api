"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const fs_1 = require("fs");
const path_1 = require("path");
const file_util_1 = require("../../common/utils/file.util");
const fs = require("fs/promises");
let UploadsService = class UploadsService {
    constructor(configService) {
        this.configService = configService;
        this.uploadPath = this.configService.get('UPLOAD_DEST', './uploads');
        this.ensureUploadDirectories();
    }
    async ensureUploadDirectories() {
        const folders = ['products', 'logos', 'templates', 'general', 'fonts', 'avatars', 'thumbnails'];
        for (const folder of folders) {
            const folderPath = (0, path_1.join)(this.uploadPath, folder);
            if (!(0, fs_1.existsSync)(folderPath)) {
                (0, fs_1.mkdirSync)(folderPath, { recursive: true });
            }
        }
    }
    async uploadFile(file, folder = 'general') {
        if (!file) {
            throw new common_1.BadRequestException({
                code: 'FILE_REQUIRED',
                message: 'Arquivo é obrigatório',
            });
        }
        const fileName = (0, file_util_1.generateFileName)(file.originalname);
        const folderPath = (0, path_1.join)(this.uploadPath, folder);
        const filePath = (0, path_1.join)(folderPath, fileName);
        if (!(0, fs_1.existsSync)(folderPath)) {
            (0, fs_1.mkdirSync)(folderPath, { recursive: true });
        }
        await fs.writeFile(filePath, file.buffer);
        const baseUrl = this.configService.get('CDN_URL', 'http://localhost:3000/uploads');
        const url = `${baseUrl}/${folder}/${fileName}`;
        return {
            id: fileName,
            filename: file.originalname,
            url,
            mimeType: (0, file_util_1.getFileMimeType)(file.originalname),
            size: file.size,
        };
    }
    async deleteFile(filePath) {
        try {
            const fullPath = (0, path_1.join)(this.uploadPath, filePath);
            if ((0, fs_1.existsSync)(fullPath)) {
                await fs.unlink(fullPath);
            }
        }
        catch (error) {
        }
    }
};
exports.UploadsService = UploadsService;
exports.UploadsService = UploadsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], UploadsService);
//# sourceMappingURL=uploads.service.js.map