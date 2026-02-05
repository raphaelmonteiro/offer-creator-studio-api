"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollaboratorsModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const collaborators_controller_1 = require("./collaborators.controller");
const collaborators_service_1 = require("./collaborators.service");
const user_entity_1 = require("../auth/entities/user.entity");
const uploads_module_1 = require("../uploads/uploads.module");
let CollaboratorsModule = class CollaboratorsModule {
};
exports.CollaboratorsModule = CollaboratorsModule;
exports.CollaboratorsModule = CollaboratorsModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([user_entity_1.User]), uploads_module_1.UploadsModule],
        controllers: [collaborators_controller_1.CollaboratorsController],
        providers: [collaborators_service_1.CollaboratorsService],
        exports: [collaborators_service_1.CollaboratorsService],
    })
], CollaboratorsModule);
//# sourceMappingURL=collaborators.module.js.map