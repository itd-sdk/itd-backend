import { type TSchema, t } from 'elysia'

// ---------------------------------------------------------------- primitives

/**
 * String enum without the implicit `default` that `t.UnionEnum` adds: Elysia applies defaults to
 * optional request properties, which would silently overwrite fields in partial updates.
 */
export function Enum<const T extends readonly [string, ...string[]]>(values: T, options: { description?: string } = {}) {
  const schema = t.UnionEnum(values as unknown as [T[number], ...T[number][]], options)
  delete (schema as { default?: unknown }).default
  return schema
}

export const Uuid = t.String({ format: 'uuid' })
export const DateTime = t.String({ format: 'date-time', examples: ['2026-01-30T12:58:14.228Z'] })
export const Nullable = <T extends TSchema>(schema: T) => t.Union([schema, t.Null()])
export const AccessTypeModel = Enum(['everyone', 'followers', 'mutual', 'nobody'])

export const ErrorModel = t.Object(
  {
    error: t.Union([
      t.Object({ code: Nullable(t.String()), message: t.String() }, { additionalProperties: true }),
      t.String()
    ])
  },
  { additionalProperties: true, description: 'Error envelope: `{"error": {"code", "message"}}`' }
)

export const SuccessModel = t.Object({ success: t.Boolean() })

export const PageQuery = t.Object({
  page: t.Optional(t.Integer({ minimum: 1, default: 1 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 20 }))
})

export const PagePaginationModel = t.Object({
  page: t.Integer(),
  limit: t.Integer(),
  total: t.Integer(),
  hasMore: t.Boolean()
})

export const CursorPaginationModel = t.Object({
  nextCursor: Nullable(t.String()),
  hasMore: t.Boolean()
})

// ---------------------------------------------------------------- users

export const PinModel = t.Object({
  slug: t.String(),
  name: t.String(),
  description: t.String(),
  url: Nullable(t.String()),
  grantedAt: Nullable(DateTime)
})

export const NicknameModel = t.Object({
  id: t.String(),
  label: t.String(),
  styleKey: t.String(),
  eventId: t.String(),
  expiresAt: DateTime,
  stateVersion: t.Integer()
})

export const LastSeenModel = t.Object({
  unit: Enum(['just_now', 'recently', 'minutes', 'hours', 'this_week', 'this_month', 'long_ago']),
  value: t.Optional(Nullable(t.Integer()))
})

const userBriefFields = {
  id: Uuid,
  username: t.String(),
  displayName: t.String(),
  avatar: t.String({ description: 'Emoji, or picture url for users with a picture avatar' }),
  clanAvatar: t.String({ description: 'Emoji avatar (clan)' }),
  verified: t.Boolean(),
  pin: Nullable(PinModel),
  activeNickname: Nullable(NicknameModel)
}

/** Compact user used as post/comment author and notification actor */
export const UserBriefModel = t.Object(userBriefFields)

export const UserListItemModel = t.Object({
  ...userBriefFields,
  bio: Nullable(t.String()),
  isPrivate: t.Boolean(),
  isFollowing: t.Boolean(),
  isFollowedBy: t.Boolean(),
  followersCount: t.Integer(),
  blockedAt: t.Optional(Nullable(DateTime))
})

export const UserProfileModel = t.Object({
  ...userBriefFields,
  banner: Nullable(t.String()),
  bio: Nullable(t.String()),
  isFollowing: t.Boolean(),
  isFollowedBy: t.Boolean(),
  hasOutgoingRequest: t.Boolean(),
  hasIncomingRequest: t.Boolean(),
  isBlockedByMe: t.Boolean(),
  isBlockedByThem: t.Boolean(),
  blockedAt: Nullable(DateTime),
  followersCount: Nullable(t.Integer()),
  followingCount: Nullable(t.Integer()),
  postsCount: Nullable(t.Integer()),
  wallAccess: Nullable(AccessTypeModel),
  likesVisibility: Nullable(AccessTypeModel),
  isPrivate: Nullable(t.Boolean()),
  canMessage: t.Boolean(),
  canPostOnWall: t.Boolean(),
  canSeeLikes: t.Boolean(),
  lastSeen: Nullable(LastSeenModel),
  online: t.Boolean(),
  pinnedPostId: Nullable(Uuid),
  createdAt: Nullable(DateTime)
})

export const SubscriptionStateModel = t.Object({
  isActive: t.Boolean(),
  expiresAt: t.Null(),
  autoRenewal: t.Boolean()
})

export const MeModel = t.Object({
  ...userBriefFields,
  banner: Nullable(t.String()),
  bio: Nullable(t.String()),
  email: t.String(),
  telegram: t.String(),
  roles: t.Array(t.String()),
  wallAccess: AccessTypeModel,
  likesVisibility: AccessTypeModel,
  messageAccess: AccessTypeModel,
  isPrivate: t.Boolean(),
  showLastSeen: t.Boolean(),
  isPhoneVerified: t.Boolean(),
  subscription: SubscriptionStateModel,
  followersCount: t.Integer(),
  followingCount: t.Integer(),
  postsCount: t.Integer(),
  pinnedPostId: Nullable(Uuid),
  createdAt: DateTime,
  isDeleted: t.Boolean(),
  canRestore: t.Optional(t.Boolean()),
  restoreDeadline: t.Optional(Nullable(DateTime))
})

export const PrivacyModel = t.Object({
  isPrivate: t.Boolean(),
  wallAccess: AccessTypeModel,
  likesVisibility: AccessTypeModel,
  messageAccess: AccessTypeModel,
  showLastSeen: t.Boolean()
})

export const UsersPageModel = t.Object({
  data: t.Object({ users: t.Array(UserListItemModel), pagination: PagePaginationModel })
})

// ---------------------------------------------------------------- content

export const SpanModel = t.Object({
  offset: t.Integer({ minimum: 0 }),
  length: t.Integer({ minimum: 1 }),
  type: t.String({ examples: ['bold', 'italic', 'link', 'hashtag', 'mention'] }),
  url: t.Optional(Nullable(t.String())),
  tag: t.Optional(Nullable(t.String()))
})

export const SpanInputModel = t.Object({
  offset: t.Integer({ minimum: 0 }),
  length: t.Integer({ minimum: 1 }),
  type: t.String({ maxLength: 32 }),
  url: t.Optional(Nullable(t.String({ maxLength: 2048 })))
})

export const AttachmentModel = t.Object({
  id: Uuid,
  type: t.Union([t.Literal('image'), t.Literal('video'), t.Literal('audio')]),
  url: t.String(),
  thumbnailUrl: Nullable(t.String()),
  width: Nullable(t.Integer()),
  height: Nullable(t.Integer()),
  filename: t.String(),
  mimeType: t.String(),
  size: t.Integer(),
  duration: Nullable(t.Integer()),
  order: t.Integer()
})

export const PollOptionModel = t.Object({ id: Uuid, text: t.String(), votesCount: t.Integer(), position: t.Integer() })

export const PollModel = t.Object({
  id: Uuid,
  postId: Uuid,
  createdAt: DateTime,
  question: t.String(),
  options: t.Array(PollOptionModel),
  multipleChoice: t.Boolean(),
  hasVoted: t.Boolean(),
  votedOptionIds: t.Array(Uuid),
  totalVotes: t.Integer()
})

const postFields = {
  id: Uuid,
  author: UserBriefModel,
  createdAt: DateTime,
  content: t.String(),
  spans: t.Array(SpanModel),
  attachments: t.Array(AttachmentModel),
  poll: Nullable(PollModel),
  likesCount: t.Integer(),
  commentsCount: t.Integer(),
  repostsCount: t.Integer(),
  viewsCount: t.Integer(),
  editedAt: Nullable(DateTime),
  isLiked: t.Boolean(),
  isReposted: t.Boolean(),
  isViewed: t.Boolean(),
  isOwner: t.Boolean(),
  isPinned: t.Boolean(),
  dominantEmoji: Nullable(t.String()),
  notebook: Nullable(t.Object({ style: t.String() })),
  revision: t.String({ description: 'Content hash for red pens and correctors' }),
  wallRecipientId: Nullable(Uuid),
  wallRecipient: Nullable(UserBriefModel),
  vs: t.String({ description: 'View session token for /v1/i dwell reports' })
}

export const PostBaseModel = t.Object(postFields)
export const PostModel = t.Object({ ...postFields, originalPost: Nullable(PostBaseModel) })

const commentFields = {
  id: Uuid,
  postId: Uuid,
  rootId: Nullable(Uuid),
  content: t.String(),
  spans: t.Array(SpanModel),
  createdAt: DateTime,
  editedAt: Nullable(DateTime),
  author: UserBriefModel,
  likesCount: t.Integer(),
  repliesCount: t.Integer(),
  isLiked: t.Boolean(),
  attachments: t.Array(AttachmentModel),
  replyTo: Nullable(UserBriefModel)
}

export const CommentBaseModel = t.Object(commentFields)
export const CommentModel = t.Object({ ...commentFields, replies: t.Array(CommentBaseModel) })

export const PostWithCommentsModel = t.Object({ ...postFields, originalPost: Nullable(PostBaseModel), comments: t.Array(CommentModel) })

export const PostsPageModel = t.Object({
  data: t.Object({ posts: t.Array(PostModel), pagination: CursorPaginationModel })
})

export const HashtagModel = t.Object({ id: Uuid, name: t.String(), postsCount: t.Integer() })

export const PostStatsModel = t.Object({
  id: Uuid,
  likesCount: t.Integer(),
  commentsCount: t.Integer(),
  repostsCount: t.Integer(),
  viewsCount: t.Integer(),
  dominantEmoji: Nullable(t.String()),
  isLiked: t.Boolean(),
  isReposted: t.Boolean()
})

// ---------------------------------------------------------------- notifications

export const NotificationTypeModel = Enum([
  'like',
  'comment',
  'reply',
  'repost',
  'mention',
  'follow',
  'follow_request',
  'follow_accepted',
  'comment_like',
  'comment_mention',
  'wall_post',
  'alice_task_reminder'
])

export const NotificationModel = t.Object({
  id: Uuid,
  type: NotificationTypeModel,
  targetType: Nullable(t.String()),
  targetId: Nullable(Uuid),
  subjectType: Nullable(t.String()),
  subjectId: Nullable(Uuid),
  preview: Nullable(t.String()),
  title: Nullable(t.String()),
  link: Nullable(t.String()),
  eventId: Nullable(t.String()),
  eventCycle: Nullable(t.Integer()),
  expiresAt: Nullable(DateTime),
  read: t.Boolean(),
  readAt: Nullable(DateTime),
  createdAt: DateTime,
  actor: Nullable(t.Object({ ...userBriefFields, isFollowing: t.Boolean(), isFollowedBy: t.Boolean() }))
})

export const NotificationSettingsModel = t.Object({
  enabled: t.Boolean(),
  webEnabled: t.Boolean(),
  sound: t.Boolean(),
  soundEnabled: t.Boolean(),
  follows: t.Boolean(),
  wallPosts: t.Boolean(),
  likes: t.Boolean(),
  comments: t.Boolean(),
  replies: t.Boolean(),
  mentions: t.Boolean(),
  preferences: t.Object({
    follows: t.Boolean(),
    reactions: t.Boolean(),
    comments: t.Boolean(),
    replies: t.Boolean(),
    mentions: t.Boolean(),
    wallPosts: t.Boolean()
  })
})

// ---------------------------------------------------------------- misc

export const FileModel = t.Object({
  id: Uuid,
  url: t.String(),
  filename: t.String(),
  mimeType: t.String(),
  size: t.Integer(),
  type: t.Union([t.Literal('image'), t.Literal('video'), t.Literal('audio')]),
  width: Nullable(t.Integer()),
  height: Nullable(t.Integer()),
  createdAt: DateTime
})

export const SessionModel = t.Object({
  id: Uuid,
  isCurrent: t.Boolean(),
  createdAt: DateTime,
  lastUsedAt: DateTime,
  expiresAt: DateTime,
  ipAddress: t.String(),
  ipCountry: Nullable(t.String()),
  ipCity: Nullable(t.String()),
  deviceType: t.Union([t.Literal('desktop'), t.Literal('mobile')]),
  osName: t.String(),
  osVersion: Nullable(t.Integer()),
  deviceModel: Nullable(t.String()),
  clientName: Nullable(t.String()),
  clientVersion: Nullable(t.String())
})
