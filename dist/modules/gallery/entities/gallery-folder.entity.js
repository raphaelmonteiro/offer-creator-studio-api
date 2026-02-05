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
exports.GalleryFolder = void 0;
const typeorm_1 = require("typeorm");
const gallery_image_entity_1 = require("./gallery-image.entity");
let GalleryFolder = class GalleryFolder {
};
exports.GalleryFolder = GalleryFolder;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], GalleryFolder.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], GalleryFolder.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], GalleryFolder.prototype, "color", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => gallery_image_entity_1.GalleryImage, (image) => image.folder),
    __metadata("design:type", Array)
], GalleryFolder.prototype, "images", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], GalleryFolder.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], GalleryFolder.prototype, "updatedAt", void 0);
exports.GalleryFolder = GalleryFolder = __decorate([
    (0, typeorm_1.Entity)('gallery_folders')
], GalleryFolder);
//# sourceMappingURL=gallery-folder.entity.js.map