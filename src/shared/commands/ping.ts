// src/shared/commands/ping.ts

import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

const data = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('This sent back with a Pong!');

const command: Command = {
    data,
    async execute(interaction) {
        await interaction.reply('Pong!');
    },
};

export default command;
