import { describe, it, expect } from 'vitest'
import request from 'supertest'
import app from '../server.js'

describe('PayTray backend skeleton', () => {
  it('returns health status', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('healthy')
    expect(response.body.service).toBe('paytray-backend')
  })

  it('rejects invalid wallet signatures at login', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        wallet: '0x742d35Cc6634C0532925a3b844Bc9e7595f42bE0',
        signature: '0x1234',
        message: 'PayTray Login'
      })

    expect(response.status).toBe(401)
  })
})
