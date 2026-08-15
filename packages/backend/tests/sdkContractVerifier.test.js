import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve(process.cwd(), 'scripts/verify-sdk-contract.mjs')

describe('SDK/OpenAPI contract verifier', () => {
  it('passes without network access and preserves safety metadata', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'ready',
      apiVersion: 'v2',
      requestsCaptured: 3,
      typeDeclarationsChecked: true,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
  })
})
