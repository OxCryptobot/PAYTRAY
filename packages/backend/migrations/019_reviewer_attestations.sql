CREATE TABLE IF NOT EXISTS reviewer_attestation_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reviewer_wallet VARCHAR(42) NOT NULL CHECK (reviewer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  role VARCHAR(32) NOT NULL CHECK (role IN ('release_operator', 'protocol_finance', 'ai_data', 'security')),
  release_commit CHAR(40) NOT NULL CHECK (release_commit ~ '^[0-9a-f]{40}$'),
  artifact_sha256 CHAR(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  public_key_fingerprint_sha256 CHAR(64) NOT NULL CHECK (public_key_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  nonce CHAR(64) NOT NULL CHECK (nonce ~ '^[0-9a-f]{64}$'),
  message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE INDEX IF NOT EXISTS reviewer_attestation_challenges_expiry_index
  ON reviewer_attestation_challenges (expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS reviewer_attestations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL UNIQUE REFERENCES reviewer_attestation_challenges(id),
  reviewer_wallet VARCHAR(42) NOT NULL CHECK (reviewer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  role VARCHAR(32) NOT NULL CHECK (role IN ('release_operator', 'protocol_finance', 'ai_data', 'security')),
  release_commit CHAR(40) NOT NULL CHECK (release_commit ~ '^[0-9a-f]{40}$'),
  artifact_sha256 CHAR(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  public_key_fingerprint_sha256 CHAR(64) NOT NULL CHECK (public_key_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  attestation_digest CHAR(64) NOT NULL CHECK (attestation_digest ~ '^[0-9a-f]{64}$'),
  decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  signature CHAR(132) NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]{130}$'),
  issued_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied BOOLEAN NOT NULL DEFAULT false CHECK (applied = false),
  release_eligible BOOLEAN NOT NULL DEFAULT false CHECK (release_eligible = false),
  settlement_authority BOOLEAN NOT NULL DEFAULT false CHECK (settlement_authority = false),
  mutation VARCHAR(32) NOT NULL DEFAULT 'read_only' CHECK (mutation = 'read_only'),
  deployment_performed BOOLEAN NOT NULL DEFAULT false CHECK (deployment_performed = false),
  settlement_mutation_performed BOOLEAN NOT NULL DEFAULT false CHECK (settlement_mutation_performed = false),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > issued_at),
  CHECK ((metadata->>'reviewerWallet') = lower(reviewer_wallet)),
  CHECK ((metadata->>'releaseCommit') = release_commit),
  CHECK ((metadata->>'artifactSha256') = artifact_sha256),
  CHECK ((metadata->>'publicKeyFingerprintSha256') = public_key_fingerprint_sha256),
  CHECK ((metadata->>'attestationDigest') = attestation_digest),
  CHECK ((metadata->>'authority') = 'reviewer_attestation_verification_only')
);

CREATE UNIQUE INDEX IF NOT EXISTS reviewer_attestations_role_commit_index
  ON reviewer_attestations (release_commit, role);

CREATE INDEX IF NOT EXISTS reviewer_attestations_commit_index
  ON reviewer_attestations (release_commit, created_at DESC);
