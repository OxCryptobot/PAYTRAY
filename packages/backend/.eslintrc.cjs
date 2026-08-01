module.exports = {
  env: {
    node: true,
    es2022: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  globals: {
    describe: 'readonly',
    it: 'readonly',
    expect: 'readonly'
  },
  ignorePatterns: ['node_modules/']
}
