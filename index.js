import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  PermissionFlagsBits,
  Events,
  EmbedBuilder
} from 'discord.js';
import fs from 'fs';

const CONFIG_PATH = './config.json';

// --- Simple JSON store helpers ---
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { guilds: {} };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const config = loadConfig();

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // needed to ban users
    GatewayIntentBits.GuildMessages,  // to listen for messages
    GatewayIntentBits.MessageContent  // to read message content (enable in Dev Portal)
  ],
  partials: [Partials.Channel, Partials.Message]
});

// --- Slash commands ---
const commands = [
  {
    name: 'bantrap',
    description: 'Configure or check the auto-ban trap channel & logging.',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      // trap channel
      {
        type: 1, // SUB_COMMAND
        name: 'set',
        description: 'Set the trap channel.',
        options: [
          { type: 7, name: 'channel', description: 'The channel to trap.', required: true } // CHANNEL
        ]
      },
      { type: 1, name: 'clear', description: 'Clear the trap channel.' },
      { type: 1, name: 'status', description: 'Show current trap channel.' },

      // log channel
      {
        type: 1,
        name: 'setlog',
        description: 'Set the log channel.',
        options: [
          { type: 7, name: 'channel', description: 'The channel for ban logs.', required: true }
        ]
      },
      { type: 1, name: 'clearlog', description: 'Clear the log channel.' },
      { type: 1, name: 'logstatus', description: 'Show the current log channel.' }
    ]
  }
];

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Register global commands (switch to per-guild for faster propagation if you like)
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'bantrap') return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (!config.guilds[guildId]) config.guilds[guildId] = { trapChannelId: null, logChannelId: null };

  // Trap channel commands
  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel', true);
    if (!('guild' in channel) || !channel.isTextBased() || channel.isThread()) {
      await interaction.reply({ content: 'Please select a **server text channel** (not a thread/voice).', ephemeral: true });
      return;
    }
    config.guilds[guildId].trapChannelId = channel.id;
    saveConfig(config);
    await interaction.reply({
      content: `✅ Trap channel set to ${channel}. Posting there will result in an **instant ban** with last 7 days of messages deleted.`,
      ephemeral: true
    });

  } else if (sub === 'clear') {
    config.guilds[guildId].trapChannelId = null;
    saveConfig(config);
    await interaction.reply({ content: '🧹 Trap channel cleared.', ephemeral: true });

  } else if (sub === 'status') {
    const trapId = config.guilds[guildId].trapChannelId;
    const msg = trapId ? `Current trap channel: <#${trapId}>` : 'No trap channel set.';
    await interaction.reply({ content: `ℹ️ ${msg}`, ephemeral: true });

  // Log channel commands
  } else if (sub === 'setlog') {
    const channel = interaction.options.getChannel('channel', true);
    if (!('guild' in channel) || !channel.isTextBased() || channel.isThread()) {
      await interaction.reply({ content: 'Please select a **server text channel** (not a thread/voice).', ephemeral: true });
      return;
    }
    config.guilds[guildId].logChannelId = channel.id;
    saveConfig(config);
    await interaction.reply({
      content: `📝 Log channel set to ${channel}. Auto-bans will be logged there.`,
      ephemeral: true
    });

  } else if (sub === 'clearlog') {
    config.guilds[guildId].logChannelId = null;
    saveConfig(config);
    await interaction.reply({ content: '🧹 Log channel cleared.', ephemeral: true });

  } else if (sub === 'logstatus') {
    const logId = config.guilds[guildId].logChannelId;
    const msg = logId ? `Current log channel: <#${logId}>` : 'No log channel set.';
    await interaction.reply({ content: `ℹ️ ${msg}`, ephemeral: true });
  }
});

// Helper: send ban log
async function sendBanLog(message, reason) {
  const gcfg = config.guilds[message.guild.id];
  const logId = gcfg?.logChannelId;
  if (!logId) return;

  const logChannel = await message.guild.channels.fetch(logId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle('🚫 Auto Ban (Trap Channel)')
    .setTimestamp(new Date())
    .addFields(
      { name: 'User', value: `${message.author.tag} (<@${message.author.id}>)`, inline: false },
      { name: 'User ID', value: message.author.id, inline: true },
      { name: 'Channel', value: `${message.channel} (${message.channelId})`, inline: true },
      { name: 'Reason', value: reason || 'Posted in trap channel', inline: false },
      { name: 'Message Link', value: `[Jump to message](${message.url})`, inline: false }
    );

  // Optional: include a small preview of their message content
  if (message.content) {
    const trimmed = message.content.length > 1000 ? `${message.content.slice(0, 1000)}…` : message.content;
    embed.addFields({ name: 'Content', value: trimmed });
  }

  await logChannel.send({ embeds: [embed] }).catch(() => {});
}

// Message watch & action
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.system || message.webhookId) return;
    if (message.author.bot) return;

    const gcfg = config.guilds[message.guild.id];
    if (!gcfg || !gcfg.trapChannelId) return;
    if (message.channelId !== gcfg.trapChannelId) return;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    // Exempt admins/mods by default (prevents accidents)
    const isStaff =
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.BanMembers);

    if (isStaff) {
      await message.delete().catch(() => {});
      return;
    }

    const reason = `Posted in trap channel #${message.channel?.name || message.channelId}`;

    await message.guild.members.ban(message.author.id, {
      deleteMessageSeconds: 604800, // 7 days
      reason
    });

    // Log the ban (if configured)
    await sendBanLog(message, reason);

    console.log(`Banned ${message.author.tag} from ${message.guild.name} for posting in trap channel.`);

  } catch (err) {
    console.error('Error in MessageCreate handler:', err);
  }
});

// Login
client.login(process.env.DISCORD_TOKEN);
