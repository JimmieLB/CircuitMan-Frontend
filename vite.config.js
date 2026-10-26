import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'
import fs from 'node:fs/promises'
import path from 'node:path'

// POST /api/agent runs the Claude circuit agent on the dev server, so the API
// key never reaches the browser. The response is newline-delimited JSON events.
function agentApi() {
  return {
    name: 'agent-api',
    configureServer(server) {
      server.middlewares.use('/api/agent', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        let body = ''
        for await (const chunk of req) body += chunk

        res.setHeader('Content-Type', 'application/x-ndjson')
        const emit = event => res.write(JSON.stringify(event) + '\n')
        const { runAgent, describeError } = await server.ssrLoadModule('/server/agent.js')
        // Read the key per request so editing .env.local takes effect without a restart.
        const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, '')
        const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY
        try {
          await runAgent({ ...JSON.parse(body), apiKey }, emit)
        } catch (err) {
          server.config.logger.error(err.stack ?? String(err))
          emit({ type: 'error', message: describeError(err) })
        }
        res.end()
      })
    },
  }
}

// POST /api/training writes exported training files into TRAINING_DIR from .env.local
// (a relative path is from the frontend folder). Without it the endpoint answers 404
// and the browser downloads the files instead. Body: { files: [{ name, data (base64) }] }.
function trainingApi() {
  return {
    name: 'training-api',
    configureServer(server) {
      server.middlewares.use('/api/training', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, '')
        const dir = process.env.TRAINING_DIR || env.TRAINING_DIR
        if (!dir) {
          res.statusCode = 404
          return res.end()
        }
        let body = ''
        for await (const chunk of req) body += chunk

        const out = path.resolve(server.config.root, dir)
        try {
          const { files } = JSON.parse(body)
          const bad = files.find(f => !/^[\w-][\w.-]*$/.test(f.name))   // plain file names only
          if (bad) throw new Error(`Refusing to write "${bad.name}"`)
          await fs.mkdir(out, { recursive: true })
          for (const f of files) await fs.writeFile(path.join(out, f.name), Buffer.from(f.data, 'base64'))
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ dir: out }))
        } catch (err) {
          server.config.logger.error(err.stack ?? String(err))
          res.statusCode = 500
          res.end(`Couldn't save to ${out}: ${err.message}`)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    agentApi(),
    trainingApi(),
  ],
})
