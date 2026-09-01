// src/modules/forumTitleExport/commands/forumTitleExportCommand.ts
//
// 管理并导出指定 Discord Forum Channel 中的全部帖子标题到 Excel。
// 论坛列表保存在 data/forum-title-export.json，不再依赖 .env。
//
// 命令：
// /论坛标题 添加 论坛:#xxx
// /论坛标题 添加 论坛id:123456789012345678
// /论坛标题 移除 论坛id:xxx
// /论坛标题 列表
// /论坛标题 导出

import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type GuildMember,
  type ThreadChannel,
} from 'discord.js';
import ExcelJS from 'exceljs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from '../../../core/types';
import {
  checkAdminPermission,
  getPermissionDeniedMessage,
} from '../../../core/utils/permissionManager';

interface ExportConfig {
  forumIds: string[];
}

interface ExportRow {
  guildName: string;
  guildId: string;
  forumName: string;
  forumId: string;
  title: string;
  threadId: string;
  threadUrl: string;
  ownerId: string;
  createdAt: Date | null;
  archived: boolean;
  locked: boolean;
  appliedTags: string;
  appliedTagIds: string;
}

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'forum-title-export.json');

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))];
}

function normalizeForumId(value: string): string {
  const trimmed = value.trim();
  const mention = trimmed.match(/^<#(\d+)>$/);
  return mention?.[1] ?? trimmed;
}

async function hasAdminPermission(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guildId) return false;

  // 正常情况下优先使用 interaction 中已经解析好的 GuildMember。
  if (interaction.guild && interaction.member) {
    const cachedMember = interaction.member as GuildMember;
    if (checkAdminPermission(cachedMember)) return true;
  }

  // 某些服务器未命中 discord.js guild cache 时 interaction.guild 会是 null，
  // 但 guildId 仍然存在。主动 fetch，避免把正常的服务器指令误判成私聊。
  try {
    const guild = interaction.guild ?? await interaction.client.guilds.fetch(interaction.guildId);
    const member = await guild.members.fetch(interaction.user.id);
    return checkAdminPermission(member);
  } catch (error) {
    console.warn(`[ForumTitleExport] 无法读取服务器 ${interaction.guildId} 的成员权限:`, error);
    return false;
  }
}

async function fetchForumById(
  interaction: ChatInputCommandInteraction,
  forumId: string,
): Promise<ForumChannel | null> {
  const channel = await interaction.client.channels.fetch(forumId);
  if (!channel || channel.type !== ChannelType.GuildForum) return null;
  return channel as ForumChannel;
}

async function loadConfig(): Promise<ExportConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ExportConfig>;
    return { forumIds: uniqueIds(Array.isArray(parsed.forumIds) ? parsed.forumIds : []) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { forumIds: [] };
    console.error('[ForumTitleExport] 读取配置失败:', error);
    throw new Error('读取论坛导出配置失败');
  }
}

async function saveConfig(config: ExportConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });

  const normalized: ExportConfig = {
    forumIds: uniqueIds(config.forumIds),
  };

  // 临时文件 + rename，避免写入过程中 Bot 意外退出导致 JSON 损坏。
  const tempPath = `${CONFIG_PATH}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(tempPath, CONFIG_PATH);
}

function threadToRow(forum: ForumChannel, thread: ThreadChannel): ExportRow {
  const tagNameMap = new Map(forum.availableTags.map(tag => [tag.id, tag.name]));
  const appliedTagIds = [...thread.appliedTags];
  const appliedTags = appliedTagIds.map(id => tagNameMap.get(id) ?? `[未知TAG:${id}]`);

  return {
    guildName: forum.guild.name,
    guildId: forum.guild.id,
    forumName: forum.name,
    forumId: forum.id,
    title: thread.name,
    threadId: thread.id,
    threadUrl: thread.url,
    ownerId: thread.ownerId ?? '',
    createdAt: thread.createdAt,
    archived: Boolean(thread.archived),
    locked: Boolean(thread.locked),
    appliedTags: appliedTags.join(' | '),
    appliedTagIds: appliedTagIds.join(' | '),
  };
}

async function fetchAllForumThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  const threads = new Map<string, ThreadChannel>();

  const active = await forum.threads.fetchActive();
  for (const thread of active.threads.values()) {
    threads.set(thread.id, thread);
  }

  let before: Date | undefined;

  while (true) {
    const archived = await forum.threads.fetchArchived({
      type: 'public',
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (archived.threads.size === 0) break;

    let oldestArchiveTimestamp: number | null = null;

    for (const thread of archived.threads.values()) {
      threads.set(thread.id, thread);

      const ts = thread.archiveTimestamp;
      if (ts !== null && (oldestArchiveTimestamp === null || ts < oldestArchiveTimestamp)) {
        oldestArchiveTimestamp = ts;
      }
    }

    if (!archived.hasMore) break;
    if (oldestArchiveTimestamp === null) {
      console.warn(`[ForumTitleExport] ${forum.guild.name}/${forum.name} 返回 hasMore=true，但没有 archiveTimestamp，停止翻页。`);
      break;
    }

    before = new Date(oldestArchiveTimestamp - 1);
  }

  return [...threads.values()];
}

async function buildWorkbook(rows: ExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ManageBot';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('帖子标题', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: '服务器', key: 'guildName', width: 24 },
    { header: '服务器ID', key: 'guildId', width: 22 },
    { header: '论坛', key: 'forumName', width: 24 },
    { header: '论坛ID', key: 'forumId', width: 22 },
    { header: '帖子标题', key: 'title', width: 60 },
    { header: '帖子ID', key: 'threadId', width: 22 },
    { header: '帖子链接', key: 'threadUrl', width: 48 },
    { header: '作者ID', key: 'ownerId', width: 22 },
    { header: '创建时间', key: 'createdAt', width: 22 },
    { header: '已归档', key: 'archived', width: 10 },
    { header: '已锁定', key: 'locked', width: 10 },
    { header: 'TAG', key: 'appliedTags', width: 40 },
    { header: 'TAG ID', key: 'appliedTagIds', width: 45 },
  ];

  for (const row of rows) sheet.addRow(row);

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };

  sheet.getColumn('createdAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount },
  };

  for (const key of ['title', 'threadUrl', 'appliedTags', 'appliedTagIds']) {
    sheet.getColumn(key).alignment = { vertical: 'top', wrapText: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

const data = new SlashCommandBuilder()
  .setName('论坛标题')
  .setDescription('（管理员）管理论坛标题导出列表并导出 Excel')
  .addSubcommand(subcommand =>
    subcommand
      .setName('添加')
      .setDescription('通过频道选择器或论坛 ID 加入导出列表')
      .addChannelOption(option =>
        option
          .setName('论坛')
          .setDescription('从当前服务器选择一个 Forum Channel')
          .addChannelTypes(ChannelType.GuildForum)
          .setRequired(false),
      )
      .addStringOption(option =>
        option
          .setName('论坛id')
          .setDescription('直接输入 Forum Channel ID，可添加 Bot 所在其他服务器的论坛')
          .setRequired(false),
      ),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('移除')
      .setDescription('按论坛 ID 从导出列表移除')
      .addStringOption(option =>
        option
          .setName('论坛id')
          .setDescription('要移除的 Forum Channel ID，可从“列表”中查看')
          .setRequired(true),
      ),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('列表')
      .setDescription('查看当前已登记的论坛'),
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('导出')
      .setDescription('导出所有已登记论坛的帖子标题为 Excel'),
  );

const command: Command = {
  data,

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ 此命令只能在服务器中使用。',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!await hasAdminPermission(interaction)) {
      return interaction.reply({
        content: getPermissionDeniedMessage(),
        flags: MessageFlags.Ephemeral,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === '添加') {
      const selectedChannel = interaction.options.getChannel('论坛', false);
      const rawForumId = interaction.options.getString('论坛id', false);

      if (!selectedChannel && !rawForumId) {
        return interaction.reply({
          content: '❌ 请选择一个论坛，或填写论坛 ID。',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (selectedChannel && rawForumId) {
        return interaction.reply({
          content: '❌ “论坛”和“论坛id”二选一即可，不要同时填写。',
          flags: MessageFlags.Ephemeral,
        });
      }

      let forum: ForumChannel | null = null;

      if (selectedChannel) {
        if (selectedChannel.type !== ChannelType.GuildForum) {
          return interaction.reply({
            content: '❌ 请选择 Forum Channel。',
            flags: MessageFlags.Ephemeral,
          });
        }
        forum = selectedChannel as ForumChannel;
      } else {
        const forumId = normalizeForumId(rawForumId!);
        if (!/^\d+$/.test(forumId)) {
          return interaction.reply({
            content: '❌ 论坛 ID 格式不正确。请填写纯数字频道 ID（也支持 `<#频道ID>`）。',
            flags: MessageFlags.Ephemeral,
          });
        }

        try {
          forum = await fetchForumById(interaction, forumId);
        } catch (error) {
          console.error(`[ForumTitleExport] 读取论坛 ${forumId} 失败:`, error);
        }

        if (!forum) {
          return interaction.reply({
            content: `❌ 无法读取论坛 \`${forumId}\`。请确认它是 Forum Channel，并且 Bot 已加入对应服务器且拥有查看该频道的权限。`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      const config = await loadConfig();
      if (config.forumIds.includes(forum.id)) {
        return interaction.reply({
          content: `ℹ️ **${forum.guild.name} / ${forum.name}**（\`${forum.id}\`）已经在导出列表中。`,
          flags: MessageFlags.Ephemeral,
        });
      }

      config.forumIds.push(forum.id);
      await saveConfig(config);

      return interaction.reply({
        content: `✅ 已加入论坛 **${forum.guild.name} / ${forum.name}**（\`${forum.id}\`）。当前共 **${config.forumIds.length}** 个论坛。`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === '移除') {
      const forumId = interaction.options.getString('论坛id', true).trim();
      const config = await loadConfig();

      if (!config.forumIds.includes(forumId)) {
        return interaction.reply({
          content: `❌ 导出列表中没有论坛 ID \`${forumId}\`。`,
          flags: MessageFlags.Ephemeral,
        });
      }

      config.forumIds = config.forumIds.filter(id => id !== forumId);
      await saveConfig(config);

      return interaction.reply({
        content: `✅ 已移除论坛 \`${forumId}\`。当前剩余 **${config.forumIds.length}** 个论坛。`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === '列表') {
      const config = await loadConfig();

      if (config.forumIds.length === 0) {
        return interaction.reply({
          content: '当前还没有登记任何论坛。使用 `/论坛标题 添加`，可选择论坛或直接输入论坛 ID。',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const lines: string[] = [];
      for (const forumId of config.forumIds) {
        try {
          const channel = await interaction.client.channels.fetch(forumId);
          if (channel?.type === ChannelType.GuildForum) {
            const forum = channel as ForumChannel;
            lines.push(`• **${forum.guild.name} / ${forum.name}** — \`${forum.id}\``);
          } else if (channel) {
            lines.push(`• ⚠️ \`${forumId}\` — 当前不是 Forum Channel`);
          } else {
            lines.push(`• ❌ \`${forumId}\` — 无法访问或已删除`);
          }
        } catch {
          lines.push(`• ❌ \`${forumId}\` — 无法访问或已删除`);
        }
      }

      return interaction.editReply(`当前已登记 **${config.forumIds.length}** 个论坛：\n${lines.join('\n')}`);
    }

    if (subcommand === '导出') {
      const config = await loadConfig();
      const forumIds = config.forumIds;

      if (forumIds.length === 0) {
        return interaction.reply({
          content: '❌ 当前没有登记论坛。请先使用 `/论坛标题 添加`。',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const rows: ExportRow[] = [];
      const errors: string[] = [];
      let successForums = 0;

      for (const forumId of forumIds) {
        try {
          const channel = await interaction.client.channels.fetch(forumId);

          if (!channel) {
            errors.push(`${forumId}: 频道不存在或 Bot 无权访问`);
            continue;
          }

          if (channel.type !== ChannelType.GuildForum) {
            errors.push(`${forumId}: 不是 Forum Channel`);
            continue;
          }

          const forum = channel as ForumChannel;
          console.log(`[ForumTitleExport] 开始抓取 ${forum.guild.name}/${forum.name} (${forum.id})`);

          const threads = await fetchAllForumThreads(forum);
          for (const thread of threads) rows.push(threadToRow(forum, thread));

          successForums += 1;
          console.log(`[ForumTitleExport] 完成 ${forum.guild.name}/${forum.name}: ${threads.length} 条帖子`);
        } catch (error) {
          console.error(`[ForumTitleExport] 抓取论坛 ${forumId} 失败:`, error);
          errors.push(`${forumId}: 抓取失败（详见 Bot 控制台）`);
        }
      }

      if (rows.length === 0) {
        const detail = errors.length > 0 ? `\n\n${errors.map(x => `• ${x}`).join('\n')}` : '';
        return interaction.editReply(`❌ 没有抓取到任何帖子。${detail}`);
      }

      rows.sort((a, b) => {
        const guild = a.guildName.localeCompare(b.guildName, 'zh-CN');
        if (guild !== 0) return guild;

        const forum = a.forumName.localeCompare(b.forumName, 'zh-CN');
        if (forum !== 0) return forum;

        const aTime = a.createdAt?.getTime() ?? 0;
        const bTime = b.createdAt?.getTime() ?? 0;
        if (aTime !== bTime) return aTime - bTime;

        return a.title.localeCompare(b.title, 'zh-CN');
      });

      const workbook = await buildWorkbook(rows);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `forum-titles-${timestamp}.xlsx`;
      const attachment = new AttachmentBuilder(workbook, { name: filename });

      const errorSummary = errors.length > 0
        ? `\n\n⚠️ 有 ${errors.length} 个论坛未成功导出：\n${errors.map(x => `• ${x}`).join('\n')}`
        : '';

      return interaction.editReply({
        content: `✅ 导出完成，共 **${rows.length}** 个帖子，成功读取 **${successForums}/${forumIds.length}** 个论坛。${errorSummary}`,
        files: [attachment],
      });
    }

    return interaction.reply({
      content: '❌ 未知子命令。',
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default command;
