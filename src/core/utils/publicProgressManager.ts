// src/core/utils/publicProgressManager.ts
//
// 负责管理长时间运行命令的进度更新，通过发送公开消息来绕过 15 分钟的交互限制。
// （当前项目未使用，作为通用工具保留，供后续长任务模块参考。）

import type { ChatInputCommandInteraction, Message, SendableChannels } from 'discord.js';

export default class PublicProgressManager {
    private interaction: ChatInputCommandInteraction;
    private channel: SendableChannels | null;
    private startTime: number;
    private lastUpdateTime = 0;
    private updateThrottleMs = 5000; // 默认5秒更新一次
    private progressMessage: Message | null = null;
    private isInitialized = false;

    constructor(interaction: ChatInputCommandInteraction) {
        this.interaction = interaction;
        this.channel = interaction.channel?.isSendable() ? interaction.channel : null;
        this.startTime = Date.now();
    }

    /**
     * 初始化进度管理器。会先回复一个临时消息，然后发送一个公开的进度消息。
     */
    async initialize(initialContent = '🔄 任务正在初始化...'): Promise<void> {
        if (this.isInitialized) return;
        if (!this.channel) {
            if (!this.interaction.replied) {
                await this.interaction.followUp({ content: '❌ 启动任务失败：当前频道无法发送消息。', ephemeral: true });
            }
            return;
        }

        try {
            if (!this.interaction.deferred) {
                await this.interaction.deferReply({ ephemeral: true });
            }

            await this.interaction.editReply({
                content: '🚀 任务已启动！进度更新将在此频道中公开显示。',
            });

            this.progressMessage = await this.channel.send({
                content: this.formatMessage(initialContent),
            });

            this.isInitialized = true;
            console.log(`公开进度消息已初始化，ID: ${this.progressMessage.id}`);
        } catch (error) {
            console.error('初始化公开进度消息失败:', error);
            this.isInitialized = false;
            if (!this.interaction.replied) {
                await this.interaction.followUp({ content: '❌ 启动任务失败，无法发送进度消息。', ephemeral: true });
            }
        }
    }

    /**
     * 更新进度消息。
     */
    async update(message: string): Promise<void> {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateThrottleMs) {
            return;
        }
        this.lastUpdateTime = now;

        if (!this.isInitialized || !this.progressMessage || !this.channel) {
            console.warn('进度管理器未初始化，无法更新。');
            return;
        }

        const content = this.formatMessage(message);
        try {
            await this.progressMessage.edit({ content });
        } catch (error) {
            console.error('更新公开进度消息失败:', error);
            // 如果消息被删了（Unknown Message），尝试重新发送
            if ((error as { code?: number }).code === 10008) {
                try {
                    this.progressMessage = await this.channel.send({ content });
                } catch (sendError) {
                    console.error('重新发送进度消息也失败了:', sendError);
                }
            }
        }
    }

    /**
     * 标记任务完成。
     */
    async finish(summary: string): Promise<void> {
        if (!this.isInitialized || !this.progressMessage || !this.channel) {
            await this.interaction.followUp({ content: `✅ **任务完成**\n\n${summary}`, ephemeral: true });
            return;
        }

        const content = `✅ **任务完成** ${this.getElapsedTime(true)}\n\n${summary}`;
        try {
            await this.progressMessage.edit({ content });
        } catch (error) {
            console.error('完成任务消息更新失败:', error);
            await this.channel.send({ content });
        }
    }

    /**
     * 发送错误信息。
     */
    async sendError(errorMessage: string): Promise<void> {
        const content = `❌ **任务失败**\n\n${errorMessage}`;
        if (this.isInitialized && this.progressMessage && this.channel) {
            try {
                await this.progressMessage.edit({ content });
            } catch (error) {
                await this.channel.send({ content });
            }
        } else {
            await this.interaction.followUp({ content, ephemeral: true });
        }
    }

    /** 格式化消息，添加时间戳。 */
    private formatMessage(message: string): string {
        return `🔄 **任务进行中** ${this.getElapsedTime()}\n\n${message}`;
    }

    /** 获取已用时间字符串。 */
    private getElapsedTime(isFinal = false): string {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = (elapsed % 60).toString().padStart(2, '0');
        const prefix = isFinal ? '⏱️ 总用时' : '⏱️';
        return `${prefix}: ${minutes}:${seconds}`;
    }
}
