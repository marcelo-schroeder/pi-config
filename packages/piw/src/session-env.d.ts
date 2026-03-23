export interface WorktreeBaseMetadata {
  input: string | null;
  resolvedRef: string | null;
  commit: string | null;
}

export interface WorktreeIntegrationMetadata {
  remote: string | null;
  branch: string | null;
  targetCommitAtCreation: string | null;
  createdFromTarget: boolean | null;
}

export interface WorktreeMetadata {
  schemaVersion: number | null;
  kind: string | null;
  name: string | null;
  branch: string | null;
  repoRoot: string | null;
  nameWasProvided: boolean | null;
  base: WorktreeBaseMetadata | null;
  integration: WorktreeIntegrationMetadata | null;
}

export interface WorktreeSessionInfo {
  active: true;
  kind: "piw";
  managed: true;
  name: string;
  path: string;
  branch: string;
  repoRoot: string;
  originalCwd: string;
  nameWasProvided: boolean | null;
  metadataComplete: boolean;
  base: WorktreeBaseMetadata | null;
  integration: WorktreeIntegrationMetadata | null;
}

export function normalizeWorktreeMetadata(raw: unknown): WorktreeMetadata | null;
export function isWorktreeMetadataComplete(metadata: WorktreeMetadata | null | undefined): boolean;
export function buildWorktreeSessionFromEnv(env?: NodeJS.ProcessEnv): WorktreeSessionInfo | null;
