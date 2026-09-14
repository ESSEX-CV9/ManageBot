export type CleanupJobStatus =
    | 'queued'
    | 'running'
    | 'paused'
    | 'cancelled'
    | 'completed'
    | 'failed';

export type CleanupScanMode = 'search' | 'history';

export interface CleanupSettings {
    guildId: string;
    manageRoleIds: string[];
    updatedBy: string | null;
    updatedAt: number;
}

export interface CleanupJob {
    id: number;
    guildId: string;
    actorId: string;
    targetUserId: string;
    selectedChannelIds: string[];
    entireGuild: boolean;
    excludedChannelIds: string[];
    includeThreads: boolean;
    cutoffAt: number;
    cutoffLabel: string;
    status: CleanupJobStatus;
    scanMode: CleanupScanMode;
    scanCompletedAt: number | null;
    scopeChannelIds: string[];
    scopeCount: number;
    cursorBatch: number;
    cursorId: string | null;
    foundCount: number;
    pendingCount: number;
    deletedCount: number;
    skippedCount: number;
    failedCount: number;
    warningText: string | null;
    error: string | null;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    updatedAt: number;
}

export interface CreateCleanupJobInput {
    guildId: string;
    actorId: string;
    targetUserId: string;
    selectedChannelIds: string[];
    entireGuild: boolean;
    excludedChannelIds: string[];
    includeThreads: boolean;
    cutoffAt: number;
    cutoffLabel: string;
}
