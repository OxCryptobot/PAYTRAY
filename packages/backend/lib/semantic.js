// Dependency-free semantic matcher: hashed character n-gram + word vectors with a synonym lexicon,
// compared by cosine similarity. Catches synonyms, typos and phrasing differences that exact match misses.

const DIM = 512

const SYNONYMS = {
  solidity: ['smart contract', 'evm', 'ethereum dev'],
  rust: ['rustlang', 'systems programming'],
  frontend: ['front end', 'ui', 'react', 'web interface'],
  backend: ['back end', 'server side', 'api development', 'node'],
  security: ['audit', 'pentest', 'infosec', 'cybersecurity'],
  defi: ['decentralized finance', 'amm', 'lending protocol'],
  ml: ['machine learning', 'ai', 'deep learning', 'data science'],
  devops: ['infrastructure', 'sre', 'kubernetes', 'ci cd'],
  design: ['ux', 'product design', 'figma']
}

const CANON = new Map()
for (const [canon, aliases] of Object.entries(SYNONYMS)) {
  CANON.set(canon, canon)
  for (const alias of aliases) CANON.set(alias, canon)
}

function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function canonicalize(text) {
  let out = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9+# ]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  for (const [alias, canon] of CANON) {
    if (alias !== canon) out = out.split(` ${alias} `).join(` ${canon} `)
  }
  return out.trim()
}

export function embed(text) {
  const vec = new Float32Array(DIM)
  const canon = canonicalize(text)
  if (!canon) return vec
  for (const word of canon.split(' ')) {
    vec[hash(`w:${word}`) % DIM] += 2
    const padded = `^${word}$`
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      vec[hash(`g:${padded.slice(i, i + 3)}`) % DIM] += 1
    }
  }
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i += 1) vec[i] /= norm
  return vec
}

export function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return Math.max(0, Math.min(1, dot))
}

// Best similarity between a query and any of a profile's expertise terms/bio (0..1).
export function semanticSkillScore(query, profile) {
  const q = embed(query)
  const terms = [...(profile.expertise || []), profile.bio || ''].filter(Boolean)
  let best = 0
  for (const term of terms) best = Math.max(best, cosine(q, embed(term)))
  return Number(best.toFixed(4))
}
