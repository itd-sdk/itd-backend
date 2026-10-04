const env = process.env

const str = (name: string, fallback: string) => env[name]?.trim() || fallback
const optional = (name: string) => env[name]?.trim() || undefined
const int = (name: string, fallback: number) => {
  const value = Number.parseInt(env[name] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}
const num = (name: string, fallback: number) => {
  const value = Number.parseFloat(env[name] ?? '')
  return Number.isFinite(value) ? value : fallback
}
const bool = (name: string, fallback: boolean) => {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}
const list = (name: string) =>
  (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const nodeEnv = str('NODE_ENV', 'development')
const isProduction = nodeEnv === 'production'
const isTest = nodeEnv === 'test'
const port = int('PORT', 3000)

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me'

export const config = {
  env: nodeEnv,
  isProduction,
  isTest,
  host: str('HOST', '0.0.0.0'),
  port,
  publicUrl: str('PUBLIC_URL', `http://localhost:${port}`).replace(/\/$/, ''),
  logLevel: str('LOG_LEVEL', isTest ? 'error' : 'info'),
  trustProxy: bool('TRUST_PROXY', false),
  corsOrigins: list('CORS_ORIGINS'),

  databaseUrl: str('DATABASE_URL', 'postgres://itd:itd@localhost:5432/itd'),
  databasePoolSize: int('DATABASE_POOL_SIZE', 20),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  redisPrefix: str('REDIS_PREFIX', 'itd:'),

  auth: {
    jwtSecret: str('JWT_SECRET', DEV_JWT_SECRET),
    jwtIssuer: str('JWT_ISSUER', 'auth-service'),
    accessTokenTtl: int('ACCESS_TOKEN_TTL', 15 * 60),
    refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
    refreshCookieName: str('REFRESH_COOKIE_NAME', 'refresh_token'),
    cookieSecure: bool('COOKIE_SECURE', isProduction),
    cookieDomain: optional('COOKIE_DOMAIN'),
    bcryptRounds: int('BCRYPT_ROUNDS', isTest ? 4 : 10),
    // one-time codes are delivered by the Telegram bot: on sign-up and, with LOGIN_CODE, on every sign-in
    telegramVerification: bool('TELEGRAM_VERIFICATION', true),
    loginCode: bool('LOGIN_CODE', true),
    exposeOtp: bool('DEV_EXPOSE_OTP', false),
    otpTtl: int('OTP_TTL', 15 * 60),
    otpResendCooldown: int('OTP_RESEND_COOLDOWN', 60),
    otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    qrTtl: int('QR_TTL', 90),
    qrRequireMobileApprover: bool('QR_REQUIRE_MOBILE_APPROVER', true),
    accountRestoreDays: int('ACCOUNT_RESTORE_DAYS', 30)
  },

  storage: {
    driver: str('STORAGE_DRIVER', 'local') as 'local' | 's3',
    uploadDir: str('UPLOAD_DIR', './uploads'),
    publicPath: str('UPLOAD_PUBLIC_PATH', '/uploads').replace(/\/$/, ''),
    s3: {
      bucket: optional('S3_BUCKET'),
      endpoint: optional('S3_ENDPOINT'),
      region: optional('S3_REGION'),
      accessKeyId: optional('S3_ACCESS_KEY_ID'),
      secretAccessKey: optional('S3_SECRET_ACCESS_KEY'),
      publicUrl: optional('S3_PUBLIC_URL')
    },
    maxImageSize: int('MAX_IMAGE_SIZE_MB', 20) * 1024 * 1024,
    maxVideoSize: int('MAX_VIDEO_SIZE_MB', 200) * 1024 * 1024,
    maxAudioSize: int('MAX_AUDIO_SIZE_MB', 50) * 1024 * 1024
  },

  rateLimit: {
    enabled: bool('RATE_LIMIT_ENABLED', true),
    multiplier: num('RATE_LIMIT_MULTIPLIER', 1)
  },

  content: {
    postMaxLength: int('POST_MAX_LENGTH', 5000),
    commentMaxLength: int('COMMENT_MAX_LENGTH', 1000),
    bioMaxLength: int('BIO_MAX_LENGTH', 500),
    maxAttachments: int('MAX_ATTACHMENTS', 10),
    editWindowHours: int('POST_EDIT_WINDOW_HOURS', 48),
    restoreWindowDays: int('POST_RESTORE_WINDOW_DAYS', 7),
    bannedWords: list('BANNED_WORDS'),
    dominantEmojiMinLikes: int('DOMINANT_EMOJI_MIN_LIKES', 3),
    popularWindowDays: int('POPULAR_WINDOW_DAYS', 7),
    popularRebuildSeconds: int('POPULAR_REBUILD_SECONDS', isTest ? 0 : 60)
  },


  event: {
    enabled: bool('EVENT_ENABLED', false),
    portalTitle: str('PORTAL_TITLE', 'Портал'),
    // the web client opens the event frame only for an active portal pointing at the event app
    portalUrl: str('PORTAL_URL', '/public/events/aliceai/'),
    portalActive: bool('PORTAL_ACTIVE', bool('EVENT_ENABLED', false)),
    id: str('EVENT_ID', 'aliceai'),
    endsAt: optional('EVENT_ENDS_AT'),
    dailyReward: int('EVENT_DAILY_REWARD', 20)
  },

  telegram: {
    // username of the bot that delivers codes (deploy/telegram-bot), shown in error messages
    botUsername: str('TELEGRAM_BOT', 'openitd_bot').replace(/^@/, '')
  },

  admin: {
    telegram: optional('ADMIN_TELEGRAM'),
    password: optional('ADMIN_PASSWORD'),
    username: str('ADMIN_USERNAME', 'admin')
  },

  jobsEnabled: bool('JOBS_ENABLED', !isTest)
}

export type Config = typeof config

export const usesDevSecret = () => config.auth.jwtSecret === DEV_JWT_SECRET

export function assertProductionConfig() {
  if (!config.isProduction) return
  if (usesDevSecret()) throw new Error('JWT_SECRET must be set in production')
  if (config.auth.exposeOtp) throw new Error('DEV_EXPOSE_OTP must be disabled in production')
}
