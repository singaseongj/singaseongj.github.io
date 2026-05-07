import { ConfigLoader } from '../src/config/config-loader.js';

async function validateConfig() {
  console.log('🔍 Validating pools configuration...\n');
  const loader = new ConfigLoader();
  try {
    const config = await loader.load('config/pools-config.json');
    console.log('✅ Config loaded successfully');

    const required = ['scoring', 'weights', 'performance', 'flags'];
    for (const field of required) {
      if (!(field in config.getAll())) throw new Error(`Missing required field: ${field}`);
    }
    console.log('✅ Required fields present');

    const checks = [
      { path: 'scoring.absolute.sizeWeight', min: 0, max: 1, name: 'Size weight' },
      { path: 'performance.globalBudgetMs', min: 10000, max: 300000, name: 'Global budget' },
      { path: 'performance.maxConcurrency', min: 1, max: 10, name: 'Max concurrency' }
    ];
    for (const check of checks) {
      const value = loader.get(check.path);
      if (value < check.min || value > check.max) console.warn(`⚠️ ${check.name} (${value}) outside [${check.min}, ${check.max}]`);
      else console.log(`✅ ${check.name}: ${value}`);
    }
    console.log('\n✅ All validations passed!');
    return true;
  } catch (error) {
    console.error(`\n❌ Validation failed: ${error.message}`);
    return false;
  }
}

validateConfig().then((success) => process.exit(success ? 0 : 1));
