#!/usr/bin/env node
/**
 * tools/validate-config.js
 *
 * 설정파일 검증
 * - JSON 구문 확인
 * - 필수 필드 확인
 * - 값 범위 검증
 * - 타입 검증
 * - 환경변수 오버라이드 테스트
 */

import { ConfigLoader } from '../src/config/config-loader.js';
import fs from 'fs/promises';

class ConfigValidator {
  constructor() {
    this.loader = new ConfigLoader();
    this.passed = 0;
    this.failed = 0;
    this.warnings = 0;
  }

  /**
   * 메인 검증 실행
   */
  async validate() {
    console.log('🔍 Validating pools configuration...\n');

    try {
      // 1. 파일 존재 확인
      await this.checkFileExists();

      // 2. JSON 구문 확인
      await this.checkJsonSyntax();

      // 3. 필수 필드 확인
      await this.checkRequiredFields();

      // 4. 값 범위 검증
      await this.checkValueRanges();

      // 5. 타입 검증
      await this.checkTypes();

      // 6. 환경변수 오버라이드 테스트
      await this.testEnvOverrides();

      // 7. 통계
      await this.printStats();

      return this.failed === 0;
    } catch (error) {
      console.error(`\n❌ Validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * 1. 파일 존재 확인
   */
  async checkFileExists() {
    console.log('Step 1: Checking file existence');

    const configPath = 'config/pools-config.json';
    try {
      await fs.stat(configPath);
      this.pass(`Config file exists: ${configPath}`);
    } catch {
      this.fail(`Config file not found: ${configPath}`);
      throw new Error(`Missing: ${configPath}`);
    }
  }

  /**
   * 2. JSON 구문 확인
   */
  async checkJsonSyntax() {
    console.log('\nStep 2: Checking JSON syntax');

    try {
      const content = await fs.readFile('config/pools-config.json', 'utf8');
      JSON.parse(content);
      this.pass('JSON syntax is valid');
    } catch (error) {
      this.fail(`JSON syntax error: ${error.message}`);
      throw error;
    }
  }

  /**
   * 3. 필수 필드 확인
   */
  async checkRequiredFields() {
    console.log('\nStep 3: Checking required fields');

    await this.loader.load('config/pools-config.json');
    const config = this.loader.getAll();

    const required = [
      'version',
      'marketCap',
      'scoring',
      'weights',
      'performance',
      'filters',
      'flags',
    ];

    for (const field of required) {
      if (field in config) {
        this.pass(`Required field present: ${field}`);
      } else {
        this.fail(`Missing required field: ${field}`);
      }
    }
  }

  /**
   * 4. 값 범위 검증
   */
  async checkValueRanges() {
    console.log('\nStep 4: Checking value ranges');

    await this.loader.load('config/pools-config.json');
    const config = this.loader.getAll();

    const checks = [
      {
        path: 'scoring.absolute.sizeWeight',
        min: 0,
        max: 1,
        name: 'Size weight',
      },
      {
        path: 'scoring.absolute.sizeWeightAggressive',
        min: 0,
        max: 1,
        name: 'Aggressive size weight',
      },
      {
        path: 'weights.absolute.news',
        min: 0,
        max: 1,
        name: 'News weight',
      },
      {
        path: 'weights.absolute.naverPopularity',
        min: 0,
        max: 1,
        name: 'Naver popularity weight',
      },
      {
        path: 'performance.globalBudgetMs',
        min: 10000,
        max: 300000,
        name: 'Global budget',
      },
      {
        path: 'performance.maxConcurrency',
        min: 1,
        max: 10,
        name: 'Max concurrency',
      },
      {
        path: 'coverage.minimum',
        min: 0,
        max: 1,
        name: 'Coverage minimum',
      },
      {
        path: 'naver.spike.boost',
        min: 0,
        max: 0.5,
        name: 'Naver spike boost',
      },
      {
        path: 'floor.base',
        min: 0,
        max: 100,
        name: 'Score floor base',
      },
      {
        path: 'ceil.default',
        min: 0,
        max: 200,
        name: 'Score ceil default',
      },
    ];

    for (const check of checks) {
      const value = this.loader.get(check.path);

      if (value == null) {
        this.warn(`Missing value at ${check.path}`);
        continue;
      }

      if (value < check.min || value > check.max) {
        this.warn(
          `${check.name} (${value}) outside recommended range [${check.min}, ${check.max}]`
        );
      } else {
        this.pass(`${check.name}: ${value}`);
      }
    }
  }

  /**
   * 5. 타입 검증
   */
  async checkTypes() {
    console.log('\nStep 5: Checking types');

    await this.loader.load('config/pools-config.json');
    const config = this.loader.getAll();

    const typeChecks = [
      { path: 'version', type: 'string' },
      { path: 'scoring.absolute.sizeWeight', type: 'number' },
      { path: 'flags.verbose', type: 'boolean' },
      { path: 'flags.offline', type: 'boolean' },
      { path: 'performance.globalBudgetMs', type: 'number' },
      { path: 'performance.maxConcurrency', type: 'number' },
    ];

    for (const check of typeChecks) {
      const value = this.loader.get(check.path);

      if (value == null) {
        this.warn(`Missing value at ${check.path}`);
        continue;
      }

      if (typeof value === check.type) {
        this.pass(`${check.path} is ${check.type}`);
      } else {
        this.fail(`${check.path} is ${typeof value}, expected ${check.type}`);
      }
    }
  }

  /**
   * 6. 환경변수 오버라이드 테스트
   */
  async testEnvOverrides() {
    console.log('\nStep 6: Testing environment variable overrides');

    const testEnv = {
      SIZE_ABS_WEIGHT: '0.9',
      GLOBAL_BUDGET_MS: '120000',
      VERBOSE: 'true',
    };

    await this.loader.load('config/pools-config.json');
    const baseConfig = this.loader.getAll();
    const overridden = this.loader.applyEnvOverrides(baseConfig, testEnv);

    const tests = [
      {
        env: 'SIZE_ABS_WEIGHT',
        path: 'scoring.absolute.sizeWeight',
        expected: 0.9,
      },
      {
        env: 'GLOBAL_BUDGET_MS',
        path: 'performance.globalBudgetMs',
        expected: 120000,
      },
      {
        env: 'VERBOSE',
        path: 'flags.verbose',
        expected: true,
      },
    ];

    for (const test of tests) {
      const value = this.getNested(overridden, test.path);

      if (value === test.expected) {
        this.pass(`${test.env} → ${test.path} = ${value}`);
      } else {
        this.fail(
          `${test.env} override failed: got ${value}, expected ${test.expected}`
        );
      }
    }
  }

  /**
   * 통계 및 요약 출력
   */
  async printStats() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 Validation Results');
    console.log('='.repeat(60));
    console.log(`✅ Passed:   ${this.passed}`);
    console.log(`❌ Failed:   ${this.failed}`);
    console.log(`⚠️ Warnings: ${this.warnings}`);

    const total = this.passed + this.failed;
    const passRate = total > 0 ? ((this.passed / total) * 100).toFixed(1) : 0;
    console.log(`\n📈 Pass Rate: ${passRate}%`);

    if (this.failed === 0) {
      console.log('\n✅ All validations passed!');
    } else {
      console.log('\n❌ Some validations failed.');
    }
  }

  // === 헬퍼 메서드 ===

  pass(message) {
    console.log(`  ✅ ${message}`);
    this.passed++;
  }

  fail(message) {
    console.log(`  ❌ ${message}`);
    this.failed++;
  }

  warn(message) {
    console.log(`  ⚠️ ${message}`);
    this.warnings++;
  }

  /**
   * 중첩 객체에서 값 가져오기
   */
  getNested(obj, path) {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current == null || !(key in current)) {
        return null;
      }
      current = current[key];
    }

    return current;
  }
}

// === 실행 ===

async function main() {
  const validator = new ConfigValidator();
  const success = await validator.validate();
  process.exit(success ? 0 : 1);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
