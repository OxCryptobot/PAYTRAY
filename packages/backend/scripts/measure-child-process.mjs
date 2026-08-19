import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const CLOCK_TICK_HZ = Number.parseInt(process.env.PROC_CLK_TCK || '100', 10)

async function sampleProcess(pid) {
  try {
    const [stat, status] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8')
    ])
    const closingParen = stat.lastIndexOf(')')
    const fields = stat.slice(closingParen + 2).trim().split(/\s+/)
    const hwm = status.match(/^VmHWM:\s+(\d+) kB$/m)
    return {
      userCpuTicks: Number(fields[11]),
      systemCpuTicks: Number(fields[12]),
      rssKb: Number(fields[21]) * 4096 / 1024,
      peakRssKb: hwm ? Number(hwm[1]) : 0
    }
  } catch {
    return null
  }
}

function appendChunk(current, chunk) {
  return `${current}${String(chunk)}`
}

export async function measureChildProcess(binary, args) {
  const startedAt = process.hrtime.bigint()
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const samples = []
  const capture = async () => {
    const value = await sampleProcess(child.pid)
    if (value) samples.push(value)
  }
  await capture()
  const timer = setInterval(() => { void capture() }, 1)
  try {
    child.stdout.on('data', (chunk) => { stdout = appendChunk(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = appendChunk(stderr, chunk) })
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    await capture()
    const first = samples[0]
    const last = samples[samples.length - 1] || first
    if (!first || !last) throw new Error('unable to capture child process resource usage')
    const elapsedMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2))
    const maxPeakRssKb = Math.max(...samples.map((sample) => sample.peakRssKb), ...samples.map((sample) => sample.rssKb))
    const resource = {
      basis: 'procfs_child_process',
      clockTickHz: CLOCK_TICK_HZ,
      elapsedMs,
      userCpuTimeMs: Number((((last.userCpuTicks - first.userCpuTicks) / CLOCK_TICK_HZ) * 1000).toFixed(2)),
      systemCpuTimeMs: Number((((last.systemCpuTicks - first.systemCpuTicks) / CLOCK_TICK_HZ) * 1000).toFixed(2)),
      peakRssKb: Math.round(maxPeakRssKb),
      exitCode: exit.code,
      signal: exit.signal
    }
    return { stdout, stderr, resource }
  } finally {
    clearInterval(timer)
  }
}

export async function main() {
  const [binary, ...args] = process.argv.slice(2)
  if (!binary) throw new Error('measure-child-process requires a binary followed by arguments')
  const result = await measureChildProcess(binary, args)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.stderr.write(`PAYTRAY_CHILD_RESOURCE ${JSON.stringify(result.resource)}\n`)
  if (result.resource.exitCode !== 0) process.exitCode = result.resource.exitCode ?? 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
