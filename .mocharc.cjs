/**
 * Mocha configuration for Hardhat TypeScript tests.
 *
 * Uses ts-node/esm to handle TypeScript files with ESM imports.
 * Required because the project has "type": "module" in package.json.
 */
module.exports = {
  require: ['ts-node/esm'],
  timeout: 120000,
};
