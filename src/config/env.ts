export const env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV === 'development',
  isProd: process.env.NODE_ENV === 'production',

  scylla: {
    contactPoints: (process.env.SCYLLA_CONTACT_POINTS || 'localhost:9042').split(','),
    localDataCenter: process.env.SCYLLA_LOCAL_DATACENTER || 'datacenter1',
    keyspace: process.env.SCYLLA_KEYSPACE || 'app',
  },

  session: {
    expiresInMs: Number(process.env.SESSION_EXPIRES_MS) || 7 * 24 * 60 * 60 * 1000, // 7 days
    cookieName: 'session',
  },
} as const;
