import type { Client } from 'discord.js';

export {
    handleCleanupButton,
    handleCleanupModal,
    handleCleanupSelect,
} from './components/messageCleanupPanel';
import { startMessageCleanupScheduler } from './services/messageCleanupScheduler';

export async function startMessageCleanupSystem(client: Client): Promise<void> {
    await startMessageCleanupScheduler(client);
    console.log('🧹 紧急消息冲水模块已加载');
}
