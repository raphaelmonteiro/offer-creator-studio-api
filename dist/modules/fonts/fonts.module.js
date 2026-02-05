"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FontsModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const fonts_controller_1 = require("./fonts.controller");
const fonts_service_1 = require("./fonts.service");
const font_entity_1 = require("./entities/font.entity");
const uploads_module_1 = require("../uploads/uploads.module");
let FontsModule = class FontsModule {
};
exports.FontsModule = FontsModule;
exports.FontsModule = FontsModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([font_entity_1.Font]), uploads_module_1.UploadsModule],
        controllers: [fonts_controller_1.FontsController],
        providers: [fonts_service_1.FontsService],
        exports: [fonts_service_1.FontsService],
    })
], FontsModule);
//# sourceMappingURL=fonts.module.js.map