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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultipartSafeValidationPipe = void 0;
const common_1 = require("@nestjs/common");
const common_2 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
let MultipartSafeValidationPipe = class MultipartSafeValidationPipe {
    constructor(request, options) {
        this.validationPipe = new common_2.ValidationPipe(options);
        this.request = request;
    }
    transform(value, metadata) {
        if (this.request?.headers['content-type']?.includes('multipart/form-data')) {
            return value;
        }
        return this.validationPipe.transform(value, metadata);
    }
};
exports.MultipartSafeValidationPipe = MultipartSafeValidationPipe;
exports.MultipartSafeValidationPipe = MultipartSafeValidationPipe = __decorate([
    (0, common_1.Injectable)({ scope: common_1.Scope.REQUEST }),
    __param(0, (0, common_1.Inject)(core_1.REQUEST)),
    __metadata("design:paramtypes", [Object, Object])
], MultipartSafeValidationPipe);
//# sourceMappingURL=multipart-safe-validation.pipe.js.map