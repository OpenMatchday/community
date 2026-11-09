import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(root, '..')

const fingerprint = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)

const assert = (cond, msg) => {
  if (!cond) {
    throw new Error(msg)
  }
}

const readJson = async (res) => JSON.parse(await res.text())

const run = (command, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: false,
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
      }
    })
  })

const loadApp = async () => {
  const entry = path.join(repoRoot, 'index.ts')
  const mod = await import(pathToFileURL(entry).href)
  return mod.default
}

const serveApp = async (app) => {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '127.0.0.1'
      const url = `http://${host}${req.url ?? '/'}`
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
      })
      const response = await app.fetch(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      res.statusCode = 500
      res.end(String(err))
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

const main = async () => {
  await run(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
  ])

  const secret = 'om-d7-local-self-check-secret'
  const env = { OM_SPIKE_SECRET: secret }
  delete process.env.DATABASE_URL
  Object.assign(process.env, env)

  const app = await loadApp()
  const { base, close } = await serveApp(app)
  try {
    const health = await readJson(await fetch(`${base}/health`))
    assert(health.ok === true, 'health ok')

    const secretBody = await readJson(await fetch(`${base}/spike/secret-read`))
    assert(secretBody.present === true, 'secret present')
    assert(secretBody.sha256_12 === fingerprint(secret), 'secret fingerprint')
    assert(!JSON.stringify(secretBody).includes(secret), 'secret value leaked')

    const auth = await readJson(await fetch(`${base}/spike/auth-stub`))
    assert(auth.status === 'stub', 'auth stub')
    assert(auth.provider === 'google', 'google provider')

    const db = await readJson(await fetch(`${base}/spike/db-presence`))
    assert(db.present === false, 'db absent without DATABASE_URL')
    assert(db.chosen === 'neon-postgres-marketplace', 'db choice label')
  } finally {
    await close()
  }

  console.log('SPIKE_CHECK_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
