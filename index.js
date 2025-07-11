const { Client, GatewayIntentBits, Routes, REST, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');

// --- Configuration ---
// These are loaded from Render's Environment Variables, NOT written here.
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Simple in-memory storage. This data is lost when the bot restarts.
const verificationStore = new Map(); // Stores { userId: { robloxUsername, phrase } }
const serverSettings = new Map();    // Stores { guildId: { verifiedRoleId } }

// Startup Check: Ensure secrets are provided in the environment.
if (!TOKEN || !CLIENT_ID) {
    console.error("FATAL ERROR: DISCORD_TOKEN or CLIENT_ID is missing from the environment variables.");
    console.error("Please set them in your hosting provider's dashboard (e.g., Render).");
    process.exit(1); // Stop the bot if secrets are missing.
}

// --- Bot Client Initialization ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers // Required for role assignments
    ]
});

client.once('ready', () => {
    console.log(`Success! Robuddie is online and logged in as ${client.user.tag}!`);
});

// --- Command Definitions ---
const commands = [
    // Everyone Commands
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Starts the primary verification process.')
        .addStringOption(option =>
            option.setName('roblox_username')
                .setDescription('Your exact Roblox username (not display name).')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('done')
        .setDescription('Finish the verification after adding the code to your profile.'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Displays a helpful message and support links.'),
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription("Checks the bot's latency and response time."),

    // Admin Commands
    new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure the verified role for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild), // Only server managers can use
    new SlashCommandBuilder()
        .setName('forceverify')
        .setDescription('Manually verifies a user and links them to a Roblox account.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addUserOption(option => option.setName('user').setDescription('The Discord user to verify.').setRequired(true))
        .addStringOption(option => option.setName('roblox_username').setDescription('The Roblox username to link.').setRequired(true)),
    
    // Premium Commands (Placeholders)
    new SlashCommandBuilder()
        .setName('premium')
        .setDescription('Access premium features (placeholder).')
        
].map(command => command.toJSON());


// --- Registering Global Slash Commands with Discord ---
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands globally.`);
        const data = await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error("Error during command registration:", error);
    }
})();


// --- Main Interaction Handler ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // --- Everyone Command Logic ---
    if (commandName === 'ping') {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true, ephemeral: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(`**Pong!** 🏓\n**Latency:** ${latency}ms\n**API Latency:** ${Math.round(client.ws.ping)}ms`);
    }

    if (commandName === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Robuddie Help & Commands')
            .setDescription('I am a bot designed to securely link your Roblox account to this Discord server.')
            .addFields(
                { name: '`/verify [roblox_username]`', value: 'Starts the verification process by sending you a unique code in DMs.' },
                { name: '`/done`', value: 'Run this after you have placed the code in your Roblox bio to get your role.' },
                { name: '`/help`', value: 'Shows this helpful message.' },
                { name: '`/ping`', value: 'Checks my response time.' },
                { name: 'For Admins', value: 'Use `/setup` to configure the bot. My role must be higher than the "Verified" role.' },
            );
        await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
    }

    if (commandName === 'verify') {
        const settings = serverSettings.get(interaction.guild.id);
        if (!settings || !settings.verifiedRoleId) {
            return interaction.reply({ content: '⚠️ **Setup Required!** An admin must run the `/setup` command before verification can begin.', ephemeral: true });
        }

        const robloxUsername = interaction.options.getString('roblox_username');
        const randomPhrase = `Robuddie-${Math.random().toString(36).substring(2, 10)}`;
        verificationStore.set(interaction.user.id, { robloxUsername, phrase: randomPhrase });

        try {
            await interaction.user.send(
                `### Verification for "${interaction.guild.name}"\n\n` +
                `1. **Copy this unique code:** \`${randomPhrase}\`\n` +
                `2. **Paste it** into your Roblox "About" section.\n` +
                `3. Go back to the server and use the \`/done\` command.`
            );
            await interaction.reply({ content: '✅ **Check your DMs!** I have sent you your unique verification code.', ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: '❌ **I could not send you a DM.** Please go to `Server Settings > Privacy Settings` and enable "Allow direct messages from server members".', ephemeral: true });
        }
    }

    if (commandName === 'done') {
        const verificationData = verificationStore.get(interaction.user.id);
        if (!verificationData) {
            return interaction.reply({ content: 'You need to start the process with `/verify` first.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const { robloxUsername, phrase } = verificationData;
        try {
            const userSearchRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [robloxUsername], excludeBannedUsers: true });
            if (userSearchRes.data.data.length === 0) {
                return interaction.editReply(`Could not find a Roblox user named "${robloxUsername}". Please check the username and try again.`);
            }
            const robloxId = userSearchRes.data.data[0].id;

            const userInfoRes = await axios.get(`https://users.roblox.com/v1/users/${robloxId}`);
            const description = userInfoRes.data.description;

            if (description && description.includes(phrase)) {
                const settings = serverSettings.get(interaction.guild.id);
                const role = interaction.guild.roles.cache.get(settings.verifiedRoleId);
                if (role) {
                    await interaction.member.roles.add(role);
                    verificationStore.delete(interaction.user.id); // Clean up
                    await interaction.editReply(`✅ **Success!** You have been verified as **${robloxUsername}** and have received the \`@${role.name}\` role.`);
                } else {
                    await interaction.editReply('Verification successful, but the configured "Verified" role seems to have been deleted. Please contact an admin.');
                }
            } else {
                await interaction.editReply('Verification failed. The code was not found in your Roblox "About" section. Please double-check it and try again.');
            }
        } catch (error) {
            console.error(error);
            await interaction.editReply('An error occurred while trying to connect to Roblox. Please try again in a moment.');
        }
    }

    // --- Admin Command Logic ---
    if (commandName === 'setup') {
        const role = interaction.guild.roles.cache.find(r => r.name === 'Verified');
        if (!role) {
            return interaction.reply({ content: 'A role named exactly "Verified" was not found. Please create one and run this command again.', ephemeral: true });
        }
        
        const botMember = await interaction.guild.members.fetch(client.user.id);
        if (botMember.roles.highest.position <= role.position) {
            return interaction.reply({ content: 'My highest role is below the "Verified" role. To assign it, please go to `Server Settings > Roles` and drag my role higher than the `Verified` role.', ephemeral: true });
        }
        
        serverSettings.set(interaction.guild.id, { verifiedRoleId: role.id });
        await interaction.reply({ content: `✅ **Setup Complete!** The verified role has been set to \`@Verified\`.`, ephemeral: true });
    }

    if (commandName === 'forceverify') {
        // Forceverify logic would go here
    }
    
    // --- Premium Command Logic ---
    if (commandName === 'premium') {
        await interaction.reply({ content: '💎 This is a **Premium** command. This feature is not yet implemented.', ephemeral: true });
    }
});

// --- Login to Discord ---
client.login(TOKEN);