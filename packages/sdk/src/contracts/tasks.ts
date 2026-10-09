/** Canonical board enums shared by tool schemas and wire arguments. */
export const TASK_LIST_STATES = ["active", "cancelled", "superseded", "archived", "all"] as const;
export const TASK_LIFECYCLE_STATES = ["active", "cancelled", "archived"] as const;
export const TASK_ASSIGNMENT_STATUSES = ["pending", "in_progress", "blocked", "in_review", "failed", "completed"] as const;
export const TASK_INCLUDE = ["history"] as const;
