import { Hono } from 'hono'
import { createApp } from './src/create-app.js'

// Vercel Hono detection requires a root entry that imports `hono`.
const app: Hono = createApp()

export default app
