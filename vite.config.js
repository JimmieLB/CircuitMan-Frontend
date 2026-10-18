import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'

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

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    agentApi(),
  ],
})
