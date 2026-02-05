export declare enum CollaboratorRole {
    COLLABORATOR = "collaborator",
    MANAGER = "manager",
    ADMIN = "admin"
}
export declare enum CollaboratorStatus {
    ACTIVE = "active",
    INACTIVE = "inactive"
}
export declare class CreateCollaboratorDto {
    name: string;
    email: string;
    phone?: string;
    role: CollaboratorRole;
    password: string;
}
