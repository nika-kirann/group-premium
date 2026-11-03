// Group permission + PREMIUM tag management (the core of the product).
import { GrammyError } from 'grammy';
import { bot, callApi, botInfoSafe } from './botInstance.js';
import { config } from './config.js';
import { log } from './logger.js';

const photosForEveryone = config.photoMode === 'guard';

/** Default permissions for regular (free) members: text only. */
export const DEFAULT_PERMISSIONS = Object.freeze({
  can_send_messages: true,
  can_send_photos: photosForEveryone, // false in native mode (spec); see README "guard" mode
  can_send_videos: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_voice_notes: false,
  can_send_video_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: true,
  can_edit_tag: false, // members must not be able to give themselves the PREMIUM tag
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false,
});

/** Per-user permissions for free members (explicitly text-only). */
export const FREE_USER_PERMISSIONS = Object.freeze({ ...DEFAULT_PERMISSIONS, can_send_photos: false });

/** Per-user permissions for premium members: text + photos, nothing else. */
export const PREMIUM_PERMISSIONS = Object.freeze({ ...DEFAULT_PERMISSIONS, can_send_photos: true });

export const REQUIRED_RIGHTS = ['can_restrict_members', 'can_manage_tags'];

const ADMIN_STATUSES = new Set(['creator', 'administrator']);

export async function getMemberSafe(userId) {
  try {
    return await bot.api.getChatMember(config.groupId, userId);
  } catch (e) {
    log.warn(`getChatMember failed for ${userId}`, e.description || e.message);
    return null;
  }
}

/** Inspect the configured chat and the bot's rights. Never throws. */
export async function inspectGroup() {
  const result = { ok: false, chatType: null, title: null, botStatus: null, rights: {}, missing: [], memberCount: null, error: null };
  try {
    const chat = await bot.api.getChat(config.groupId);
    result.chatType = chat.type;
    result.title = chat.title;
    result.currentPermissions = chat.permissions ?? null;
    const me = botInfoSafe() ?? (await bot.api.getMe());
    const member = await bot.api.getChatMember(config.groupId, me.id);
    result.botStatus = member.status;
    for (const r of [...REQUIRED_RIGHTS, 'can_delete_messages']) result.rights[r] = Boolean(member[r]);
    result.missing = member.status === 'administrator'
      ? REQUIRED_RIGHTS.filter((r) => !member[r])
      : REQUIRED_RIGHTS.slice();
    if (photosForEveryone && !member.can_delete_messages) result.missing.push('can_delete_messages (required by PHOTO_MODE=guard)');
    try { result.memberCount = await bot.api.getChatMemberCount(config.groupId); } catch { /* optional */ }
    result.ok = chat.type === 'supergroup' && member.status === 'administrator' && result.missing.length === 0;
    if (chat.type !== 'supergroup') result.error = `Chat type is "${chat.type}". Convert the group to a supergroup (make it public once or enable chat history for new members).`;
    else if (member.status !== 'administrator') result.error = 'The bot is not an administrator of the group.';
    else if (result.missing.length) result.error = `Missing administrator rights: ${result.missing.join(', ')}`;
  } catch (e) {
    result.error = e instanceof GrammyError ? e.description : e.message;
  }
  return result;
}

/** Set the group's default permissions (text-only for regular members). */
export async function applyDefaultPermissions() {
  return bot.api.setChatPermissions(config.groupId, DEFAULT_PERMISSIONS, { use_independent_chat_permissions: true });
}

/**
 * Grant premium in the group: photo permission until expiry + PREMIUM tag.
 * Returns { applied, tagged, reason }.
 */
export async function grantInGroup(userId, expiresAt) {
  const member = await getMemberSafe(userId);
  if (!member || member.status === 'left' || member.status === 'kicked') {
    return { applied: false, tagged: false, reason: 'not_in_group' };
  }
  if (ADMIN_STATUSES.has(member.status)) {
    // Never change administrator permissions; admins can already send photos.
    return { applied: true, tagged: false, reason: 'is_admin' };
  }
  const untilDate = Math.floor(new Date(expiresAt).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (untilDate - now < 60) return { applied: false, tagged: false, reason: 'already_expired' };
  // Telegram treats >366 days as forever; manual grants are clamped to stay finite.
  const safeUntil = Math.min(untilDate, now + 365 * 86400);
  let applied = false; let tagged = false; let reason = null;
  try {
    await bot.api.restrictChatMember(config.groupId, userId, PREMIUM_PERMISSIONS, {
      use_independent_chat_permissions: true,
      until_date: safeUntil,
    });
    applied = true;
  } catch (e) { reason = `restrict: ${e.description || e.message}`; }
  try {
    await callApi('setChatMemberTag', { chat_id: config.groupId, user_id: userId, tag: config.premiumTag });
    tagged = true;
  } catch (e) { reason = (reason ? reason + '; ' : '') + `tag: ${e.description || e.message}`; }
  return { applied, tagged, reason };
}

/** Remove premium in the group: photos off (text stays), PREMIUM tag removed. */
export async function revokeInGroup(userId) {
  const member = await getMemberSafe(userId);
  if (!member) return { applied: false, reason: 'lookup_failed' };
  if (member.status === 'left' || member.status === 'kicked') return { applied: true, reason: 'not_in_group' };
  if (ADMIN_STATUSES.has(member.status)) return { applied: true, reason: 'is_admin' };
  let reason = null; let ok = true;
  try {
    await bot.api.restrictChatMember(config.groupId, userId, FREE_USER_PERMISSIONS, { use_independent_chat_permissions: true });
  } catch (e) { ok = false; reason = `restrict: ${e.description || e.message}`; }
  if (member.tag || member.tag === undefined) {
    try {
      // Omitting `tag` (or passing an empty string) removes the member tag.
      await callApi('setChatMemberTag', { chat_id: config.groupId, user_id: userId, tag: '' });
    } catch (e) {
      if (!/not modified/i.test(e.description || '')) { ok = false; reason = (reason ? reason + '; ' : '') + `tag: ${e.description || e.message}`; }
    }
  }
  return { applied: ok, reason };
}

/** Apply text-only permissions to a newly joined non-premium member. */
export async function applyFreeToNewMember(userId) {
  const member = await getMemberSafe(userId);
  if (!member || ADMIN_STATUSES.has(member.status) || member.status === 'left' || member.status === 'kicked') return;
  if (config.photoMode === 'guard') return; // guard mode enforces by deleting photos instead
  await bot.api.restrictChatMember(config.groupId, userId, FREE_USER_PERMISSIONS, { use_independent_chat_permissions: true })
    .catch((e) => log.warn(`Could not restrict new member ${userId}`, e.description || e.message));
}
