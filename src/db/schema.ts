import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core'
import { v7 as uuidv7 } from 'uuid'

// Millisecond precision keeps JS Date <-> Postgres round-trips exact (keyset cursors rely on it)
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: 'date' })
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7())
const createdAt = () => ts('created_at').notNull().defaultNow()

export type Role = 'user' | 'admin'
export type AccessType = 'everyone' | 'followers' | 'mutual' | 'nobody'
export type SpanType = 'monospace' | 'strike' | 'bold' | 'italic' | 'spoiler' | 'underline' | 'hashtag' | 'link' | 'quote' | 'mention'
export type Span = { offset: number; length: number; type: SpanType; url?: string | null; tag?: string | null }
export type FileKind = 'image' | 'video' | 'audio'
export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'repost'
  | 'mention'
  | 'follow'
  | 'follow_request'
  | 'follow_accepted'
  | 'comment_like'
  | 'comment_mention'
  | 'wall_post'
  | 'alice_task_reminder'

// ---------------------------------------------------------------- auth

export const accounts = pgTable('accounts', {
  id: id(),
  // login: Telegram username, lowercase without @
  telegram: text('telegram').notNull().unique(),
  // chat that confirmed the account; codes keep going there even if the username changes
  telegramChatId: text('telegram_chat_id'),
  passwordHash: text('password_hash').notNull(),
  verifiedAt: ts('verified_at'),
  roles: text('roles').array().$type<Role[]>().notNull().default(sql`'{user}'::text[]`),
  bannedAt: ts('banned_at'),
  bannedUntil: ts('banned_until'),
  banReason: text('ban_reason'),
  passwordChangedAt: ts('password_changed_at'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow()
})

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    deviceId: text('device_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    ipCountry: text('ip_country'),
    ipCity: text('ip_city'),
    deviceType: text('device_type').$type<'desktop' | 'mobile'>().notNull().default('desktop'),
    osName: text('os_name').notNull().default('Unknown'),
    osVersion: integer('os_version'),
    deviceModel: text('device_model'),
    clientName: text('client_name'),
    clientVersion: text('client_version'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokeReason: text('revoke_reason')
  },
  (t) => [index('sessions_account_idx').on(t.accountId), index('sessions_expires_idx').on(t.expiresAt)]
)

// ---------------------------------------------------------------- files

export const files = pgTable(
  'files',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    url: text('url').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    kind: text('kind').$type<FileKind>().notNull(),
    width: integer('width'),
    height: integer('height'),
    duration: integer('duration'),
    thumbnailUrl: text('thumbnail_url'),
    purpose: text('purpose').$type<'media' | 'avatar'>().notNull().default('media'),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at')
  },
  (t) => [index('files_owner_idx').on(t.ownerId, t.createdAt)]
)

// ---------------------------------------------------------------- pins (profile badges)

export const pins = pgTable('pins', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  url: text('url'),
  createdAt: createdAt()
})

// ---------------------------------------------------------------- users (profiles)

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    // emoji avatar; users sharing the same emoji form a "clan"
    avatar: text('avatar').notNull(),
    avatarFileId: uuid('avatar_file_id').references(() => files.id, { onDelete: 'set null' }),
    bannerFileId: uuid('banner_file_id').references(() => files.id, { onDelete: 'set null' }),
    bio: text('bio'),
    verified: boolean('verified').notNull().default(false),
    phoneVerified: boolean('phone_verified').notNull().default(false),
    // denormalized from accounts.banned_at so content queries can hide banned authors cheaply
    isBanned: boolean('is_banned').notNull().default(false),
    isPrivate: boolean('is_private').notNull().default(false),
    wallAccess: text('wall_access').$type<AccessType>().notNull().default('everyone'),
    likesVisibility: text('likes_visibility').$type<AccessType>().notNull().default('everyone'),
    messageAccess: text('message_access').$type<AccessType>().notNull().default('everyone'),
    showLastSeen: boolean('show_last_seen').notNull().default(true),
    lastSeenAt: ts('last_seen_at'),
    pinnedPostId: uuid('pinned_post_id').references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),
    activePinSlug: text('active_pin_slug').references(() => pins.slug, { onDelete: 'set null' }),
    followersCount: integer('followers_count').notNull().default(0),
    followingCount: integer('following_count').notNull().default(0),
    postsCount: integer('posts_count').notNull().default(0),
    deletedAt: ts('deleted_at'),
    restoreDeadline: ts('restore_deadline'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`),
    index('users_avatar_idx').on(t.avatar),
    index('users_followers_idx').on(t.followersCount),
    index('users_username_trgm_idx').using('gin', sql`lower(${t.username}) gin_trgm_ops`),
    index('users_display_name_trgm_idx').using('gin', sql`lower(${t.displayName}) gin_trgm_ops`)
  ]
)

export const userPins = pgTable(
  'user_pins',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pinSlug: text('pin_slug')
      .notNull()
      .references(() => pins.slug, { onDelete: 'cascade' }),
    grantedAt: ts('granted_at').notNull().defaultNow()
  },
  (t) => [primaryKey({ columns: [t.userId, t.pinSlug] })]
)

// ---------------------------------------------------------------- social graph

export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followingId: uuid('following_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followingId] }), index('follows_following_idx').on(t.followingId, t.createdAt)]
)

export const followRequests = pgTable(
  'follow_requests',
  {
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.requesterId, t.targetId] }), index('follow_requests_target_idx').on(t.targetId, t.createdAt)]
)

export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('blocks_blocked_idx').on(t.blockedId)]
)

// ---------------------------------------------------------------- posts

export const posts = pgTable(
  'posts',
  {
    id: id(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wallRecipientId: uuid('wall_recipient_id').references(() => users.id, { onDelete: 'cascade' }),
    originalPostId: uuid('original_post_id').references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),
    content: text('content').notNull().default(''),
    spans: jsonb('spans').$type<Span[]>().notNull().default([]),
    likesCount: integer('likes_count').notNull().default(0),
    commentsCount: integer('comments_count').notNull().default(0),
    repostsCount: integer('reposts_count').notNull().default(0),
    viewsCount: integer('views_count').notNull().default(0),
    dominantEmoji: text('dominant_emoji'),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    deletedBy: uuid('deleted_by'),
    createdAt: createdAt()
  },
  (t) => [
    index('posts_author_idx').on(t.authorId, t.createdAt),
    index('posts_wall_idx').on(t.wallRecipientId, t.createdAt),
    index('posts_created_idx').on(t.createdAt),
    index('posts_original_idx').on(t.originalPostId),
    uniqueIndex('posts_one_repost_idx')
      .on(t.authorId, t.originalPostId)
      .where(sql`${t.originalPostId} is not null and ${t.deletedAt} is null`)
  ]
)

export const postAttachments = pgTable(
  'post_attachments',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.postId, t.fileId] }), index('post_attachments_file_idx').on(t.fileId)]
)

export const postLikes = pgTable(
  'post_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    // liker's clan (emoji avatar) at like time, used for the post's dominant emoji
    clan: text('clan').notNull(),
    createdAt: createdAt()
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.postId] }),
    index('post_likes_post_idx').on(t.postId),
    index('post_likes_user_idx').on(t.userId, t.createdAt)
  ]
)

export const postViews = pgTable(
  'post_views',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] }), index('post_views_user_idx').on(t.userId)]
)

export const hashtags = pgTable(
  'hashtags',
  {
    id: id(),
    name: text('name').notNull().unique(),
    postsCount: integer('posts_count').notNull().default(0),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at').notNull().defaultNow()
  },
  (t) => [index('hashtags_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`), index('hashtags_posts_idx').on(t.postsCount)]
)

export const postHashtags = pgTable(
  'post_hashtags',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    hashtagId: uuid('hashtag_id')
      .notNull()
      .references(() => hashtags.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.hashtagId, t.postId] }), index('post_hashtags_tag_idx').on(t.hashtagId, t.createdAt), index('post_hashtags_post_idx').on(t.postId)]
)

// ---------------------------------------------------------------- polls

export const polls = pgTable('polls', {
  id: id(),
  postId: uuid('post_id')
    .notNull()
    .unique()
    .references(() => posts.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  multipleChoice: boolean('multiple_choice').notNull().default(false),
  totalVotes: integer('total_votes').notNull().default(0),
  createdAt: createdAt()
})

export const pollOptions = pgTable(
  'poll_options',
  {
    id: id(),
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    position: smallint('position').notNull(),
    votesCount: integer('votes_count').notNull().default(0)
  },
  (t) => [index('poll_options_poll_idx').on(t.pollId)]
)

export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    optionId: uuid('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.optionId, t.userId] }), index('poll_votes_poll_user_idx').on(t.pollId, t.userId)]
)

// ---------------------------------------------------------------- comments

export const comments = pgTable(
  'comments',
  {
    id: id(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // replies are one level deep: rootId points to the top-level comment
    rootId: uuid('root_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    replyToUserId: uuid('reply_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    content: text('content').notNull().default(''),
    spans: jsonb('spans').$type<Span[]>().notNull().default([]),
    likesCount: integer('likes_count').notNull().default(0),
    repliesCount: integer('replies_count').notNull().default(0),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt()
  },
  (t) => [index('comments_post_idx').on(t.postId, t.createdAt), index('comments_root_idx').on(t.rootId, t.createdAt), index('comments_author_idx').on(t.authorId)]
)

export const commentAttachments = pgTable(
  'comment_attachments',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.commentId, t.fileId] }), index('comment_attachments_file_idx').on(t.fileId)]
)

export const commentLikes = pgTable(
  'comment_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (t) => [primaryKey({ columns: [t.userId, t.commentId] }), index('comment_likes_comment_idx').on(t.commentId)]
)

// ---------------------------------------------------------------- notifications

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<NotificationType>().notNull(),
    targetType: text('target_type').$type<'post'>(),
    targetId: uuid('target_id'),
    subjectType: text('subject_type').$type<'post' | 'comment'>(),
    subjectId: uuid('subject_id'),
    preview: text('preview'),
    title: text('title'),
    link: text('link'),
    eventId: text('event_id'),
    eventCycle: integer('event_cycle'),
    expiresAt: ts('expires_at'),
    dedupeKey: text('dedupe_key'),
    readAt: ts('read_at'),
    createdAt: createdAt()
  },
  (t) => [
    index('notifications_recipient_idx').on(t.recipientId, t.createdAt),
    index('notifications_unread_idx')
      .on(t.recipientId)
      .where(sql`${t.readAt} is null`),
    uniqueIndex('notifications_dedupe_idx')
      .on(t.recipientId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`)
  ]
)

export const notificationSettings = pgTable('notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  webEnabled: boolean('web_enabled').notNull().default(true),
  sound: boolean('sound').notNull().default(true),
  follows: boolean('follows').notNull().default(true),
  wallPosts: boolean('wall_posts').notNull().default(true),
  likes: boolean('likes').notNull().default(true),
  comments: boolean('comments').notNull().default(true),
  replies: boolean('replies').notNull().default(true),
  mentions: boolean('mentions').notNull().default(true),
  updatedAt: ts('updated_at').notNull().defaultNow()
})

// ---------------------------------------------------------------- moderation

export const reports = pgTable(
  'reports',
  {
    id: id(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: text('target_type').$type<'post' | 'user' | 'comment'>().notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason').$type<'spam' | 'violence' | 'hate' | 'adult' | 'fraud' | 'other'>().notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<'pending' | 'resolved' | 'rejected'>().notNull().default('pending'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex('reports_unique_idx').on(t.reporterId, t.targetType, t.targetId), index('reports_status_idx').on(t.status, t.createdAt)]
)

export const bannedWords = pgTable('banned_words', {
  word: text('word').primaryKey(),
  createdAt: createdAt()
})

export const verificationRequests = pgTable(
  'verification_requests',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoUrl: text('video_url').notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    rejectionReason: text('rejection_reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow()
  },
  (t) => [index('verification_user_idx').on(t.userId, t.createdAt), index('verification_status_idx').on(t.status)]
)

// ---------------------------------------------------------------- platform content

export const appVersions = pgTable('app_versions', {
  name: text('name').primaryKey(),
  minVersion: text('min_version').notNull(),
  latestVersion: text('latest_version').notNull(),
  updateUrl: text('update_url').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow()
})

export const changelog = pgTable('changelog', {
  version: text('version').primaryKey(),
  date: text('date').notNull(),
  changes: text('changes').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt()
})

export type AnnouncementButton = { title: string; style: 'primary' | 'secondary'; action: { type: 'dismiss' | 'link'; url?: string | null } }

export const announcements = pgTable('announcements', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  additionalText: text('additional_text'),
  image: jsonb('image').$type<{ url: string; width?: number | null; height?: number | null } | null>(),
  buttons: jsonb('buttons').$type<AnnouncementButton[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt()
})

// ---------------------------------------------------------------- seasonal event ("aliceai")

export const eventWallets = pgTable('event_wallets', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  redPens: integer('red_pens').notNull().default(0),
  correctors: integer('correctors').notNull().default(0),
  activeNicknameId: text('active_nickname_id'),
  updatedAt: ts('updated_at').notNull().defaultNow()
})

export const eventItems = pgTable(
  'event_items',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'sticker' | 'eraser' | 'window' | 'stain' | 'whoopee_cushion'>().notNull(),
    asset: text('asset'),
    createdAt: createdAt(),
    usedAt: ts('used_at')
  },
  (t) => [index('event_items_user_idx').on(t.userId)]
)

export const eventNicknames = pgTable(
  'event_nicknames',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    styleKey: text('style_key').notNull().default('default'),
    eventId: text('event_id').notNull().default('aliceai'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt()
  },
  (t) => [index('event_nicknames_user_idx').on(t.userId)]
)

export const eventProfiles = pgTable('event_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  rev: integer('rev').notNull().default(0),
  windowBrokenAt: ts('window_broken_at'),
  windowAsset: text('window_asset'),
  curtainsFund: integer('curtains_fund').notNull().default(0),
  curtainsGoal: integer('curtains_goal').notNull().default(100),
  curtainsAvailable: boolean('curtains_available').notNull().default(false),
  curtainsClosed: boolean('curtains_closed').notNull().default(false),
  aura: integer('aura').notNull().default(0),
  claimedAt: ts('claimed_at'),
  updatedAt: ts('updated_at').notNull().defaultNow()
})

export type EventAnchor = { kind: 'banner' | 'profile_header' | 'post'; id?: string | null }

export const eventPlacements = pgTable(
  'event_placements',
  {
    id: id(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'sticker' | 'stain'>().notNull(),
    asset: text('asset'),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    z: doublePrecision('z').notNull().default(0),
    size: doublePrecision('size').notNull().default(1),
    angle: doublePrecision('angle').notNull().default(0),
    wear: integer('wear').notNull().default(0),
    anchor: jsonb('anchor').$type<EventAnchor>().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: ts('expires_at'),
    erasedAt: ts('erased_at')
  },
  (t) => [index('event_placements_profile_idx').on(t.profileId)]
)

export const postMarks = pgTable(
  'post_marks',
  {
    id: id(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'red_pen' | 'corrector'>().notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull().default('aliceai'),
    revision: text('revision').notNull(),
    start: integer('start').notNull(),
    end: integer('end').notNull(),
    replacement: text('replacement'),
    reportsCount: integer('reports_count').notNull().default(0),
    createdAt: createdAt(),
    canceledAt: ts('canceled_at')
  },
  (t) => [index('post_marks_post_idx').on(t.postId, t.kind)]
)
