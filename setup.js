import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const configPath = join(homedir(), '.claude', 'claude_desktop_config.json')
const serverPath = join(process.cwd(), 'server', 'index.js')

let config = {}
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch {
  // File doesn't exist yet — start fresh
}

config.mcpServers = config.mcpServers || {}
config.mcpServers['creative-context'] = {
  command: 'node',
  args: [serverPath]
}

mkdirSync(join(homedir(), '.claude'), { recursive: true })
writeFileSync(configPath, JSON.stringify(config, null, 2))

console.log(`✓ MCP config written to ${configPath}`)
console.log(`  Server path: ${serverPath}`)
console.log('\nQuit Claude desktop and reopen it to activate.')
