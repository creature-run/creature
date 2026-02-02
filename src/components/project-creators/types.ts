/**
 * Project Creator Types
 *
 * Shared types and interfaces for project creation flows.
 * Each profile can have its own custom status types.
 */

import type { ProjectWithValidation } from "../../electron/preload";

/**
 * Result returned by project creators when complete.
 */
export interface ProjectCreatorResult {
  project: ProjectWithValidation;
}

/**
 * Props for all project creator components.
 */
export interface ProjectCreatorProps {
  onComplete: (result: ProjectCreatorResult) => void;
  onCancel: () => void;
}

