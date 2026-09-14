import type { Client, Message, PartialMessage } from 'discord.js';

export {
    handleCleanupButton,
    handleCleanupModal,
    handleCleanupSelect,
} from './components/messageCleanupPanel';
import { startMessageCleanupScheduler } from './services/messageCleanupScheduler';
import { recordLiveIndexedMessage, removeIndexedMessages } from './services/messageCleanupDatabase';
import { refreshMessageCleanupConsoleSnapshots } from './services/messageCleanupService';

export function messageCleanupMessageCreateHandler(message: Message): void {
    if (!message.guildId) return;
    recordLiveIndexedMessage({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        createdAt: message.createdTimestamp,
    });
}

export function messageCleanupMessageDeleteHandler(message: Message | PartialMessage): void {
    removeIndexedMessages([message.id]);
}

export function messageCleanupMessageBulkDeleteHandler(
    messages: ReadonlyMap<string, unknown>,
): void {
    removeIndexedMessages([...messages.keys()]);
}

export async function startMessageCleanupSystem(client: Client): Promise<void> {
    refreshMessageCleanupConsoleSnapshots(client);
    await startMessageCleanupScheduler(client);
    console.log('🧹 紧急消息冲水模块已加载');
}
