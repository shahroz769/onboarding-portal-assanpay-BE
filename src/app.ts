import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { env } from './config/env.js'
import { errorHandler } from './middleware/error-handler.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { caseRoutes } from './modules/cases/cases.routes.js'
import { configurationRoutes } from './modules/configuration/configuration.routes.js'
import { merchantFormRoutes } from './modules/merchants/form.routes.js'
import { merchantRoutes } from './modules/merchants/merchants.routes.js'
import { agreementUploadRoutes } from './modules/merchants/public-agreement.routes.js'
import { midGoLiveRoutes } from './modules/merchants/public-mid-go-live.routes.js'
import { resubmissionRoutes } from './modules/merchants/public-resubmission.routes.js'
import { notificationRoutes } from './modules/notifications/notifications.routes.js'
import { queueRoutes } from './modules/queues/queues.routes.js'
import { userRoutes } from './modules/users/users.routes.js'
import type { AppEnv } from './types/auth.js'

export const app = new Hono<AppEnv>()

app.use(
  '*',
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
  }),
)

app.onError(errorHandler)

app.route('/api/auth', authRoutes)
app.route('/api/public', merchantFormRoutes)
app.route('/api/public/resubmission', resubmissionRoutes)
app.route('/api/public/agreement', agreementUploadRoutes)
app.route('/api/public/mid-go-live', midGoLiveRoutes)
app.route('/api/merchants', merchantRoutes)
app.route('/api/users', userRoutes)
app.route('/api/queues', queueRoutes)
app.route('/api/cases', caseRoutes)
app.route('/api/configuration', configurationRoutes)
app.route('/api/notifications', notificationRoutes)