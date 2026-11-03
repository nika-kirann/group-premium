// Telegram bot: commands, payments, group events. Webhook mode only.
import { InlineKeyboard } from 'grammy';
import { bot } from './botInstance.js';
import { config, isAdmin } from './config.js';
import { upsertUser, setSetting, query } from './db.js';
import { log } from './logger.js';
import { hashPassword } from './auth.js';
import { inspectGroup, applyDefaultPermissions, applyFreeToNewMember } from './permissions.js';
import {
  createSubscriptionLink, handlePreCheckout, processSuccessfulPayment, processRefund, setAutoRenew,
  getSubscription, getStats, maybeSyncExpirations, applyGroupGrant,
} from './subscriptions.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const fmtDate = (d) => new Date(d).toUTCString().replace(':00 GMT', ' UTC');
function remaining(d) {
  const ms = new Date(d).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86400000); const hours = Math.floor((ms % 86400000) / 3600000); const mins = Math.floor((ms % 3600000) / 60000);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
}
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const botLink = (start) => `https://t.me/${bot.botInfo.username}${start ? `?start=${start}` : ''}`;

const RENEW_NOTICE = '🔁 <b>Auto-renews every 30 days</b> for ' + config.priceStars + ' ⭐ unless you cancel with /cancel_subscription. Cancelling keeps your benefits until the end of the paid period.';

/* ---------- middleware ---------- */
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) upsertUser(ctx.from).catch((e) => log.warn('upsertUser failed', e.message));
  await next();
  // Opportunistic, DB-throttled expiry sync on bot activity (no in-memory timers needed).
  maybeSyncExpirations(60).catch(() => {});
});

const adminOnly = async (ctx, next) => {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.chat?.type === 'private') await ctx.reply('⛔ This command is for group administrators only.');
    return;
  }
  return next();
};

const privateOnly = (cmd) => async (ctx, next) => {
  if (ctx.chat?.type !== 'private') {
    return ctx.reply(`Please use /${cmd} in a private chat with me.`, {
      reply_markup: new InlineKeyboard().url('💬 Open private chat', botLink(cmd === 'subscribe' ? 'subscribe' : undefined)),
      reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id, allow_sending_without_reply: true } : undefined,
    }).catch(() => {});
  }
  return next();
};

/* ---------- user commands ---------- */
const mainMenu = () => new InlineKeyboard()
  .text('💎 Get Premium', 'subscribe').text('📊 My status', 'status').row()
  .text('❓ Help', 'help');

async function sendStart(ctx) {
  const name = esc(ctx.from?.first_name || 'there');
  await ctx.reply(
    `✨ <b>Welcome to GROUP PREMIUM, ${name}!</b>\n\n` +
    `Our group has two membership levels:\n\n` +
    `💬 <b>Free member</b>\n• Send text messages\n\n` +
    `💎 <b>Premium member</b> — ${config.priceStars} ⭐ / 30 days\n• Send text messages\n• <b>Send photos</b>\n• Native <code>PREMIUM</code> member tag\n\n` +
    `${RENEW_NOTICE}`, { ...HTML, reply_markup: mainMenu() });
}

async function sendOffer(ctx) {
  const user = ctx.from;
  const sub = await getSubscription(user.id);
  const active = sub?.status === 'ACTIVE' && new Date(sub.expires_at) > new Date();
  let link;
  try { link = await createSubscriptionLink(user); } catch (e) {
    log.error('createInvoiceLink failed', e.description || e.message);
    return ctx.reply('⚠️ Could not create the payment link right now. Please try again in a moment.');
  }
  const head = active
    ? `💎 <b>You are already Premium</b> (until ${fmtDate(sub.expires_at)}).\n${sub.auto_renew ? 'Auto-renewal is ON — no need to pay again.' : 'Auto-renewal is OFF. Subscribing again starts a new recurring plan.'}\n\n`
    : '';
  await ctx.reply(
    head +
    `💎 <b>GROUP PREMIUM</b>\n\n` +
    `💰 <b>Price:</b> ${config.priceStars} ⭐ Telegram Stars\n` +
    `📅 <b>Period:</b> 30 days\n\n` +
    `<b>You get:</b>\n✅ Send photos in the group\n✅ <code>PREMIUM</code> member tag\n✅ Text messages (as always)\n\n` +
    `${RENEW_NOTICE}\n\n` +
    `<i>Premium is activated only after Telegram confirms your payment.</i>`,
    { ...HTML, reply_markup: new InlineKeyboard().url(`⭐ Subscribe for ${config.priceStars} Stars`, link) });
}

async function sendStatus(ctx) {
  const sub = await getSubscription(ctx.from.id);
  if (!sub || sub.status === 'NONE') {
    return ctx.reply('📊 <b>Your membership</b>\n\nStatus: 💬 <b>Free member</b> (text only)\n\nUpgrade with /subscribe.', { ...HTML, reply_markup: new InlineKeyboard().text('💎 Get Premium', 'subscribe') });
  }
  const active = sub.status === 'ACTIVE' && new Date(sub.expires_at) > new Date();
  const lines = [
    '📊 <b>Your membership</b>\n',
    `Status: ${active ? '💎 <b>PREMIUM — active</b>' : sub.status === 'REVOKED' ? '⛔ <b>Revoked</b>' : '⌛ <b>Expired</b>'}`,
  ];
  if (sub.expires_at) lines.push(`${active ? 'Expires' : 'Ended'}: <b>${fmtDate(sub.expires_at)}</b>`);
  if (active) {
    lines.push(`Time remaining: <b>${remaining(sub.expires_at)}</b>`);
    lines.push(`Auto-renewal: ${sub.source === 'manual' ? '— (granted by admin)' : sub.auto_renew ? '🔁 <b>ON</b> — renews for ' + config.priceStars + ' ⭐' : '⏹ <b>OFF</b> — will not renew'}`);
    if (!sub.group_applied) lines.push('\n⚠️ Your group perks will be applied as soon as you are a member of the group.');
  }
  const kb = new InlineKeyboard();
  if (active && sub.auto_renew) kb.text('⏹ Cancel auto-renewal', 'cancel_ask');
  else if (active && sub.source === 'stars' && sub.first_charge_id) kb.text('🔁 Re-enable auto-renewal', 'resume');
  else kb.text('💎 Get Premium', 'subscribe');
  return ctx.reply(lines.join('\n'), { ...HTML, reply_markup: kb });
}

async function sendHelp(ctx) {
  let text = '❓ <b>GROUP PREMIUM — Help</b>\n\n' +
    '/start — Welcome & plans\n/subscribe — Get Premium (' + config.priceStars + ' ⭐ / 30 days)\n/status — Your membership, expiry & renewal\n/cancel_subscription — Stop auto-renewal (keep access until period end)\n/help — This message\n\n' +
    '💡 Payments are handled natively by Telegram Stars. Premium is activated automatically after Telegram confirms the payment.\n\n' +
    '🆘 <b>Support:</b> contact a group administrator. For payment disputes use /paysupport.';
  if (isAdmin(ctx.from?.id)) {
    text += '\n\n🛠 <b>Admin</b>\n/setup — Verify bot rights & configure group permissions\n/stats — Statistics\n/premium — Premium plan & enforcement info\n/setpassword &lt;password&gt; — Set your dashboard password (private chat)';
  }
  return ctx.reply(text, HTML);
}

async function askCancel(ctx) {
  const sub = await getSubscription(ctx.from.id);
  if (!sub || sub.status !== 'ACTIVE' || new Date(sub.expires_at) <= new Date()) return ctx.reply('You have no active Premium subscription.');
  if (!sub.auto_renew) return ctx.reply(`Auto-renewal is already off. Premium stays active until <b>${fmtDate(sub.expires_at)}</b>.`, HTML);
  return ctx.reply(
    `⏹ <b>Cancel auto-renewal?</b>\n\nYou won't be charged again. Your Premium perks stay active until <b>${fmtDate(sub.expires_at)}</b> (${remaining(sub.expires_at)} left).`,
    { ...HTML, reply_markup: new InlineKeyboard().text('Yes, cancel renewal', 'cancel_yes').text('Keep it', 'cancel_no') });
}

async function doCancel(ctx) {
  const r = await setAutoRenew(ctx.from.id, false);
  if (!r.ok) {
    const msg = r.reason === 'no_active' ? 'You have no active Premium subscription.'
      : r.reason === 'not_recurring' ? 'Your Premium was granted by an admin and does not renew.'
        : `⚠️ Telegram rejected the cancellation: ${esc(r.reason)}. You can also cancel in Telegram → Settings → My Stars.`;
    return ctx.reply(msg, HTML);
  }
  return ctx.reply(`✅ Auto-renewal cancelled. No further charges.\n💎 Premium stays active until <b>${fmtDate(r.sub.expires_at)}</b>.`, HTML);
}

bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private') return sendStart(ctx);
  if (ctx.match === 'subscribe') return sendOffer(ctx);
  return sendStart(ctx);
});
bot.command('subscribe', privateOnly('subscribe'), sendOffer);
bot.command('status', privateOnly('status'), sendStatus);
bot.command('cancel_subscription', privateOnly('cancel_subscription'), askCancel);
bot.command('help', sendHelp);
bot.command('paysupport', (ctx) => ctx.reply('🧾 For payment issues, contact a group administrator with your Telegram ID: <code>' + ctx.from.id + '</code>. Refunds are processed by admins via the bot.', HTML));
bot.command('terms', (ctx) => ctx.reply(`📜 GROUP PREMIUM is a ${config.priceStars} ⭐ subscription renewing every 30 days until cancelled. It unlocks photo sending and a PREMIUM tag in the group. Group rules still apply; admins may revoke access for rule violations.`));

bot.callbackQuery('subscribe', async (ctx) => { await ctx.answerCallbackQuery(); if (ctx.chat?.type !== 'private') return ctx.reply('Open a private chat with me to subscribe.', { reply_markup: new InlineKeyboard().url('💬 Open', botLink('subscribe')) }); return sendOffer(ctx); });
bot.callbackQuery('status', async (ctx) => { await ctx.answerCallbackQuery(); if (ctx.chat?.type === 'private') return sendStatus(ctx); });
bot.callbackQuery('help', async (ctx) => { await ctx.answerCallbackQuery(); return sendHelp(ctx); });
bot.callbackQuery('cancel_ask', async (ctx) => { await ctx.answerCallbackQuery(); return askCancel(ctx); });
bot.callbackQuery('cancel_no', async (ctx) => { await ctx.answerCallbackQuery('Kept — auto-renewal stays on.'); await ctx.editMessageReplyMarkup().catch(() => {}); });
bot.callbackQuery('cancel_yes', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageReplyMarkup().catch(() => {}); return doCancel(ctx); });
bot.callbackQuery('resume', async (ctx) => {
  await ctx.answerCallbackQuery();
  const r = await setAutoRenew(ctx.from.id, true);
  return ctx.reply(r.ok ? '🔁 Auto-renewal re-enabled. ' + RENEW_NOTICE : `⚠️ Could not re-enable: ${esc(r.reason)}`, HTML);
});

/* ---------- admin commands ---------- */
function setupReport(i) {
  const tick = (b) => (b ? '✅' : '❌');
  return `🛠 <b>Group setup check</b>\n\n` +
    `Group: <b>${esc(i.title ?? config.groupId)}</b>\n` +
    `${tick(i.chatType === 'supergroup')} Type: ${esc(i.chatType ?? 'unknown')}\n` +
    `${tick(i.botStatus === 'administrator')} Bot status: ${esc(i.botStatus ?? 'unknown')}\n` +
    `${tick(i.rights.can_restrict_members)} Restrict members\n` +
    `${tick(i.rights.can_manage_tags)} Manage member tags\n` +
    `${config.photoMode === 'guard' ? tick(i.rights.can_delete_messages) : '➖'} Delete messages ${config.photoMode === 'guard' ? '(needed for guard mode)' : '(optional)'}\n` +
    (i.memberCount != null ? `👥 Members: ${i.memberCount}\n` : '') +
    (i.error ? `\n⚠️ ${esc(i.error)}` : '');
}

bot.command('setup', adminOnly, async (ctx) => {
  const i = await inspectGroup();
  if (!i.ok) return ctx.reply(setupReport(i) + '\n\nFix the issues above (Group → Administrators → bot) and run /setup again.', HTML);
  return ctx.reply(setupReport(i) +
    `\n\n⚠️ <b>Confirm default permissions change</b>\nThis will change the permissions of <b>all regular members</b> of the group:\n` +
    `• Text messages: ✅ allowed\n• Photos: ${config.photoMode === 'guard' ? '✅ allowed by Telegram, but the bot deletes photos from non-premium members' : '❌ blocked (Premium only)'}\n` +
    `• Videos, audio, files, voice, video notes, polls, stickers/GIFs: ❌ blocked\n• Editing own tag: ❌ blocked\n\nAdministrators are not affected.`,
  { ...HTML, reply_markup: new InlineKeyboard().text('✅ Apply permissions', 'setup_apply').text('✖️ Cancel', 'setup_cancel') });
});
bot.callbackQuery('setup_cancel', adminOnly, async (ctx) => { await ctx.answerCallbackQuery('Cancelled'); await ctx.editMessageReplyMarkup().catch(() => {}); });
bot.callbackQuery('setup_apply', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
  await ctx.answerCallbackQuery('Applying…');
  await ctx.editMessageReplyMarkup().catch(() => {});
  try {
    await applyDefaultPermissions();
    await setSetting('group_setup', { at: new Date().toISOString(), by: ctx.from.id, mode: config.photoMode });
    // Re-apply perks to all active premium members (setChatPermissions does not touch per-user exceptions, but be safe).
    const { rows } = await query(`SELECT telegram_id, expires_at FROM subscriptions WHERE status='ACTIVE' AND expires_at > now() + interval '2 minutes'`);
    for (const r of rows) await applyGroupGrant(r.telegram_id, r.expires_at);
    return ctx.reply(`✅ <b>Group configured.</b> Regular members are now text-only. ${rows.length} premium member(s) re-synced.`, HTML);
  } catch (e) {
    return ctx.reply(`❌ Failed: ${esc(e.description || e.message)}`, HTML);
  }
});

bot.command('stats', adminOnly, async (ctx) => {
  const s = await getStats();
  let members = 'n/a';
  try { members = await bot.api.getChatMemberCount(config.groupId); } catch { /* ignore */ }
  return ctx.reply(`📈 <b>Statistics</b>\n\n👥 Group members: <b>${members}</b>\n💎 Active premium: <b>${s.active}</b>\n🔁 Auto-renew on: <b>${s.auto_renew}</b>\n⌛ Expired: <b>${s.expired}</b>\n⛔ Revoked: <b>${s.revoked}</b>\n🧾 Successful payments: <b>${s.payments}</b>\n⭐ Stars earned: <b>${s.stars}</b>\n🙋 Known users: <b>${s.users}</b>`, HTML);
});

bot.command('premium', adminOnly, (ctx) => ctx.reply(
  `💎 <b>Premium plan</b>\n\nPrice: ${config.priceStars} ⭐ (XTR)\nPeriod: ${config.subscriptionPeriod}s (30 days), auto-renewing\nTag: <code>${config.premiumTag}</code>\nPhoto mode: <b>${config.photoMode}</b>\nDashboard: ${esc(config.baseUrl)}/admin\n\nPerks are granted with restrictChatMember(until_date = expiry) + setChatMemberTag, and removed by the expiry sync.`, HTML));

bot.command('setpassword', adminOnly, async (ctx) => {
  if (ctx.chat.type !== 'private') { await ctx.deleteMessage().catch(() => {}); return ctx.reply('🔐 Use /setpassword only in a private chat with me.'); }
  const pw = (ctx.match || '').trim();
  await ctx.deleteMessage().catch(() => {});
  if (pw.length < 12 || pw.length > 128) return ctx.reply('🔐 Usage: /setpassword <password> — 12 to 128 characters. Your message is deleted automatically.');
  const hash = await hashPassword(pw);
  await query(`INSERT INTO admin_credentials (telegram_id, password_hash) VALUES ($1,$2)
    ON CONFLICT (telegram_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, failed_logins=0, locked_until=NULL, updated_at=now()`, [ctx.from.id, hash]);
  await query('DELETE FROM admin_sessions WHERE telegram_id=$1', [ctx.from.id]);
  return ctx.reply(`✅ Dashboard password saved (scrypt hash). Log in at ${config.baseUrl}/admin with Telegram ID <code>${ctx.from.id}</code>.`, HTML);
});

/* ---------- payments ---------- */
bot.on('pre_checkout_query', handlePreCheckout);

bot.on('message:successful_payment', async (ctx) => {
  const sp = ctx.message.successful_payment;
  let r;
  try { r = await processSuccessfulPayment(ctx.from, sp); } catch (e) {
    log.error('processSuccessfulPayment failed', e);
    // Rethrown by bot.catch -> webhook returns 500 -> Telegram redelivers (idempotent by charge id).
    throw e;
  }
  if (r.rejected) return ctx.reply('⚠️ We received a payment we could not verify. An administrator has been notified; please contact support with /paysupport.');
  if (r.duplicate) return;
  const g = r.group;
  const where = g.applied
    ? '📸 You can now send photos in the group and wear the <b>PREMIUM</b> tag.'
    : g.reason === 'not_in_group'
      ? '👉 Join the group — your perks will be applied automatically when you join.' + (config.groupInviteLink ? `\n${esc(config.groupInviteLink)}` : '')
      : '⏳ Your perks are being applied to the group and will appear shortly.';
  await ctx.reply(`🎉 <b>${r.isRenewal ? 'Premium renewed!' : 'Welcome to Premium!'}</b>\n\n✅ Payment confirmed: ${sp.total_amount} ⭐\n📅 Active until: <b>${fmtDate(r.expiresAt)}</b>\n\n${where}\n\n${RENEW_NOTICE}`, HTML);
  for (const id of config.adminIds) bot.api.sendMessage(id, `💰 ${r.isRenewal ? 'Renewal' : 'New subscription'}: ${esc(ctx.from.first_name)} (${ctx.from.id}) paid ${sp.total_amount} ⭐`, HTML).catch(() => {});
});

bot.on('message:refunded_payment', async (ctx) => {
  const changed = await processRefund(ctx.from, ctx.message.refunded_payment);
  if (changed) await ctx.reply('↩️ Your payment was refunded and Premium has been removed.');
});

/* ---------- group events ---------- */
bot.on('chat_member', async (ctx) => {
  const upd = ctx.chatMember;
  if (upd.chat.id !== config.groupId) return;
  const user = upd.new_chat_member.user;
  if (user.is_bot) return;
  const was = upd.old_chat_member.status; const now = upd.new_chat_member.status;
  const joined = ['left', 'kicked'].includes(was) && ['member', 'restricted'].includes(now);
  if (!joined) return;
  await upsertUser(user);
  const sub = await getSubscription(user.id);
  if (sub?.status === 'ACTIVE' && new Date(sub.expires_at) > new Date(Date.now() + 60000)) {
    await applyGroupGrant(user.id, sub.expires_at);
  } else {
    await applyFreeToNewMember(user.id);
  }
});

bot.on('my_chat_member', async (ctx) => {
  if (ctx.chat.id !== config.groupId) return;
  const s = ctx.myChatMember.new_chat_member;
  log.info(`Bot status in group changed to ${s.status}`);
  for (const id of config.adminIds) bot.api.sendMessage(id, `ℹ️ Bot status in the group changed to <b>${esc(s.status)}</b>. Run /setup to verify.`, HTML).catch(() => {});
});

// Guard mode: delete photos from non-premium members (requires can_delete_messages).
if (config.photoMode === 'guard') {
  bot.on('message:photo', async (ctx, next) => {
    if (ctx.chat.id !== config.groupId || !ctx.from || ctx.senderChat) return next();
    const m = await ctx.getChatMember(ctx.from.id).catch(() => null);
    if (m && ['creator', 'administrator'].includes(m.status)) return next();
    const sub = await getSubscription(ctx.from.id);
    if (sub?.status === 'ACTIVE' && new Date(sub.expires_at) > new Date()) return next();
    await ctx.deleteMessage().catch(() => {});
    const n = await ctx.reply(`📸 ${esc(ctx.from.first_name)}, photos are a Premium perk.`, { ...HTML, reply_markup: new InlineKeyboard().url('💎 Get Premium', botLink('subscribe')) }).catch(() => null);
    if (n) setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, n.message_id).catch(() => {}), 15000);
  });
}

bot.catch((err) => {
  log.error(`Bot error on update ${err.ctx?.update?.update_id}`, err.error);
  // For payment updates, propagate the error so the webhook answers 500 and Telegram
  // redelivers the update later. The UNIQUE charge id keeps the retry idempotent.
  if (err.ctx?.update?.message?.successful_payment) throw err.error;
});

export const BOT_COMMANDS = {
  default: [
    { command: 'start', description: 'Welcome & membership plans' },
    { command: 'subscribe', description: `Get Premium — ${config.priceStars} ⭐ / 30 days` },
    { command: 'status', description: 'Your membership status' },
    { command: 'cancel_subscription', description: 'Stop auto-renewal' },
    { command: 'help', description: 'Help & support' },
  ],
  admin: [
    { command: 'setup', description: 'Verify & configure group permissions' },
    { command: 'stats', description: 'Member & subscription statistics' },
    { command: 'premium', description: 'Premium plan information' },
    { command: 'setpassword', description: 'Set dashboard password' },
  ],
};

export async function registerCommands() {
  await bot.api.setMyCommands(BOT_COMMANDS.default);
  for (const id of config.adminIds) {
    await bot.api.setMyCommands([...BOT_COMMANDS.default, ...BOT_COMMANDS.admin], { scope: { type: 'chat', chat_id: id } })
      .catch(() => { /* admin has not started the bot yet */ });
  }
}

export { bot };
